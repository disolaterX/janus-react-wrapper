import { useEffect, useState, useCallback } from "react";
import type { JanusJS } from "janus-gateway";
import Janus from "janus-gateway";
import adapter from "webrtc-adapter";

// Define WebView interface types
interface WebViewWindow extends Window {
  webkit?: {
    messageHandlers?: {
      janusHandler?: {
        postMessage: (message: unknown) => void;
      };
    };
  };
  android?: {
    onJanusMessage: (message: string) => void;
  };
}

// Define call states
type CallState =
  | "idle"
  | "registering"
  | "registered"
  | "calling"
  | "ringing"
  | "connected"
  | "ended"
  | "error";

// Define message payload types
type WebViewPayload = {
  phoneNumber?: string;
  error?: string;
  status?: string;
  data?: unknown;
  kind?: string;
  isConnected?: boolean;
  state?: string;
  registration?: SipRegistrationParams;
  callState?: CallState;
  errorDetails?: {
    code?: number;
    message: string;
  };
};

// Define types for WebView messages
type WebViewMessage = {
  type: string;
  payload: WebViewPayload;
};

// Define Janus specific types
interface SipPluginResult {
  event?: string;
  result?: string;
  code?: number;
  [key: string]: unknown;
}

// Add new types for registration
interface SipRegistrationParams {
  username?: string;
  displayName?: string;
  authuser?: string;
  secret?: string;
  proxy?: string;
  userAgent?: string;
  register?: boolean;
}

function App() {
  const [sipPlugin, setSipPlugin] = useState<JanusJS.PluginHandle | null>(null);
  const [isWebViewReady, setIsWebViewReady] = useState(false);
  const [callState, setCallState] = useState<CallState>("idle");
  const [currentCall, setCurrentCall] = useState<string | null>(null);
  const [isRegistered, setIsRegistered] = useState(false);
  const janusDependencies = Janus.useDefaultDependencies({ adapter });

  const [sipCredentials, setSipCredentials] = useState<SipRegistrationParams>(
    {}
  );

  // Function to send messages to WebView with retry mechanism
  const sendToWebView = useCallback(
    (message: WebViewMessage, retryCount = 3) => {
      const webViewWindow = window as WebViewWindow;
      try {
        if (webViewWindow.webkit?.messageHandlers?.janusHandler) {
          webViewWindow.webkit.messageHandlers.janusHandler.postMessage(
            message
          );
        } else if (webViewWindow.android?.onJanusMessage) {
          webViewWindow.android.onJanusMessage(JSON.stringify(message));
        } else {
          console.log(
            "WebView interface not found, running in browser:",
            message
          );
          if (retryCount > 0) {
            setTimeout(() => sendToWebView(message, retryCount - 1), 1000);
          }
        }
      } catch (error) {
        console.error("Error sending message to WebView:", error);
        if (retryCount > 0) {
          setTimeout(() => sendToWebView(message, retryCount - 1), 1000);
        }
      }
    },
    []
  );

  // Function to handle registration
  const handleRegistration = useCallback(
    (params?: SipRegistrationParams) => {
      if (!sipPlugin) {
        const error = "SIP plugin not found";
        console.error(error);
        sendToWebView({ type: "REGISTRATION_ERROR", payload: { error } });
        return;
      }

      setCallState("registering");

      // Merge provided params with defaults
      const registrationParams = {
        ...sipCredentials,
        ...params,
        register: true, // Always set register to true for registration
      };

      // Update stored credentials
      setSipCredentials(registrationParams);

      // Send registration request
      sipPlugin.send({
        message: {
          request: "register",
          username: registrationParams.username,
          display_name: registrationParams.displayName,
          authuser: registrationParams.authuser,
          secret: registrationParams.secret,
          proxy: registrationParams.proxy,
          user_agent: registrationParams.userAgent,
          register: true,
        },
      });
    },
    [sipPlugin, sipCredentials, sendToWebView]
  );

  // Function to handle unregistration
  const handleUnregister = useCallback(() => {
    if (!sipPlugin || !isRegistered) return;

    sipPlugin.send({
      message: {
        request: "unregister",
      },
    });
  }, [sipPlugin, isRegistered]);

  const makeCall = useCallback(
    (phoneNumber?: string) => {
      if (!sipPlugin) {
        const error = "SIP plugin not found";
        console.error(error);
        sendToWebView({
          type: "CALL_ERROR",
          payload: { error, callState: "error" },
        });
        setCallState("error");
        return;
      }

      if (!phoneNumber) {
        const error = "Phone number is required";
        console.error(error);
        sendToWebView({
          type: "CALL_ERROR",
          payload: { error, callState: "error" },
        });
        setCallState("error");
        return;
      }

      // Extract domain from proxy and provide fallback
      const proxyDomain =
        sipCredentials.proxy?.split("sip:")[1] || "103.230.84.119:5080";

      setCurrentCall(phoneNumber);
      setCallState("calling");

      sipPlugin.createOffer({
        tracks: [{ type: "audio", capture: true }],
        success: (jsep: JanusJS.JSEP) => {
          sipPlugin.send({
            message: {
              request: "call",
              uri: `sip:${phoneNumber}@${proxyDomain}`,
            },
            jsep,
          });
          sendToWebView({
            type: "CALL_INITIATED",
            payload: {
              phoneNumber,
              callState: "calling",
            },
          });
        },
        error: (error: Error) => {
          console.error("Error creating offer:", error);
          sendToWebView({
            type: "CALL_ERROR",
            payload: {
              error: error.message,
              callState: "error",
            },
          });
          setCallState("error");
        },
      });
    },
    [sipPlugin, sipCredentials, sendToWebView]
  );

  // Handle messages from WebView
  useEffect(() => {
    const handleWebViewMessage = (event: MessageEvent<WebViewMessage>) => {
      const message = event.data;

      switch (message.type) {
        case "WEBVIEW_READY":
          setIsWebViewReady(true);
          break;
        case "REGISTER_SIP":
          handleRegistration(message.payload?.registration);
          break;
        case "UNREGISTER_SIP":
          handleUnregister();
          break;
        case "MAKE_CALL":
          if (!isRegistered) {
            sendToWebView({
              type: "CALL_ERROR",
              payload: { error: "Not registered with SIP server" },
            });
            return;
          }
          makeCall(message.payload?.phoneNumber);
          break;
        case "END_CALL":
          if (sipPlugin && currentCall) {
            sipPlugin.send({ message: { request: "hangup" } });
          }
          break;
        default:
          console.log("Unknown message from WebView:", message);
      }
    };

    window.addEventListener("message", handleWebViewMessage as EventListener);
    sendToWebView({ type: "REACT_APP_READY", payload: {} });

    return () => {
      window.removeEventListener(
        "message",
        handleWebViewMessage as EventListener
      );
    };
  }, [
    sipPlugin,
    isRegistered,
    currentCall,
    handleRegistration,
    handleUnregister,
    sendToWebView,
    makeCall,
  ]);

  // Handle SIP plugin messages
  const handleSipMessage = useCallback(
    (msg: JanusJS.Message, jsep?: JanusJS.JSEP) => {
      console.log(msg.error || msg.result);
      const result = msg.result as SipPluginResult;

      // Handle registration states
      if (result?.event === "registered") {
        setIsRegistered(true);
        setCallState("registered");
      } else if (result?.event === "unregistered") {
        setIsRegistered(false);
        setCallState("idle");
      }

      // Handle call states
      if (result?.event === "calling") {
        setCallState("calling");
      } else if (result?.event === "ringing") {
        setCallState("ringing");
      } else if (result?.event === "accepted") {
        setCallState("connected");
      } else if (result?.event === "hangup") {
        setCallState("ended");
        setCurrentCall(null);
      }

      sendToWebView({
        type: "SIP_STATUS",
        payload: {
          status: result?.event || "unknown",
          data: msg,
          callState: callState,
        },
      });

      if (jsep) {
        sipPlugin?.handleRemoteJsep({
          jsep,
          success: () => {
            console.log("Remote jsep handled successfully");
          },
          error: (error: string) => {
            console.error(error);
            sendToWebView({
              type: "JSEP_ERROR",
              payload: {
                error,
                callState: "error",
              },
            });
            setCallState("error");
          },
        });
      }
    },
    [callState, sendToWebView]
  );

  // Initialize Janus with error handling and reconnection
  useEffect(() => {
    let janus: JanusJS.Janus | null = null;
    let reconnectAttempts = 0;
    const MAX_RECONNECT_ATTEMPTS = 3;

    const initializeJanus = () => {
      console.log("Initializing Janus...");
      Janus.init({
        debug: true,
        dependencies: janusDependencies,
        callback: () => {
          janus = new Janus({
            server: "wss://janus.conf.meetecho.com/ws",
            iceServers: [
              { urls: "stun:stun.l.google.com:19302" },
              { urls: "stun:stun1.l.google.com:19302" },
            ],
            ipv6: false,
            withCredentials: false,
            success: () => {
              reconnectAttempts = 0; // Reset reconnect attempts on successful connection
              attachSipPlugin();
            },
            error: (error: string) => {
              console.error("Error creating Janus session:", error);
              sendToWebView({
                type: "JANUS_ERROR",
                payload: {
                  error,
                  errorDetails: {
                    code: 500,
                    message: "Failed to create Janus session",
                  },
                },
              });

              // Attempt reconnection
              if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                reconnectAttempts++;
                console.log(
                  `Attempting to reconnect (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`
                );
                setTimeout(initializeJanus, 5000);
              }
            },
            destroyed: () => {
              console.log("Janus session destroyed");
              sendToWebView({ type: "JANUS_DESTROYED", payload: {} });
              setIsRegistered(false);
              setCallState("idle");
              setSipPlugin(null);
            },
          });
        },
      });
    };

    const attachSipPlugin = () => {
      if (!janus) return;

      janus.attach({
        plugin: "janus.plugin.sip",
        success: (pluginHandle: JanusJS.PluginHandle) => {
          setSipPlugin(pluginHandle);
          handleRegistration();
          sendToWebView({ type: "SIP_READY", payload: {} });
        },
        error: (error: string) => {
          console.error("Error attaching to SIP plugin:", error);
          sendToWebView({
            type: "SIP_ERROR",
            payload: {
              error,
              errorDetails: {
                code: 501,
                message: "Failed to attach SIP plugin",
              },
            },
          });
        },
        onmessage: handleSipMessage,
        onlocaltrack: (track: MediaStreamTrack) => {
          console.log("Local track available:", track);
          sendToWebView({
            type: "LOCAL_TRACK_READY",
            payload: { kind: track.kind },
          });
        },
        onremotetrack: (track: MediaStreamTrack) => {
          console.log("Remote track available:", track);
          sendToWebView({
            type: "REMOTE_TRACK_READY",
            payload: { kind: track.kind },
          });
        },
        oncleanup: () => {
          console.log("SIP plugin cleaned up");
          sendToWebView({ type: "SIP_CLEANUP", payload: {} });
          setCallState("idle");
          setCurrentCall(null);
        },
        webrtcState: (isConnected) => {
          console.log("WebRTC state changed:", isConnected);
          sendToWebView({
            type: "WEBRTC_STATE",
            payload: { isConnected },
          });
        },
        iceState: (state) => {
          console.log("ICE state changed:", state);
          sendToWebView({ type: "ICE_STATE", payload: { state } });
        },
      });
    };

    initializeJanus();

    return () => {
      if (sipPlugin) {
        sipPlugin.detach({
          success: () => {
            console.log("SIP plugin detached");
            sendToWebView({ type: "SIP_DETACHED", payload: {} });
          },
          error: (error: string) => {
            console.error("Error detaching SIP plugin:", error);
            sendToWebView({ type: "DETACH_ERROR", payload: { error } });
          },
        });
      }
      if (janus) {
        janus.destroy({
          success: () => console.log("Janus destroyed successfully"),
          error: (error: string) =>
            console.error("Error destroying Janus:", error),
        });
      }
    };
  }, [janusDependencies, handleRegistration, handleSipMessage, sendToWebView]);

  return isWebViewReady ? (
    <div style={{ display: "none" }}>
      WebView Ready - Call State: {callState}
    </div>
  ) : (
    <div>
      <h1>WebView Not Ready</h1>
    </div>
  );
}

export default App;
