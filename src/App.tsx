import { useEffect, useState, useCallback } from "react";
import type { JanusJS } from "janus-gateway";
// Import Janus differently to ensure it's loaded properly
import JanusModule from "janus-gateway";
import adapter from "webrtc-adapter";

// Create a reference to the Janus constructor
const Janus: typeof JanusModule = JanusModule;

// Define call states
type CallState =
  | "idle"
  | "registering"
  | "registered"
  | "calling"
  | "ringing"
  | "connected"
  | "ended"
  | "error"
  | "starting"
  | "destroyed"
  | "cleaned"
  | "not_started"
  | "initializing"
  | "ready";

// Define message payload types
type WebViewPayload = {
  phoneNumber?: string;
  error?: string;
  status?: string;
  data?: unknown;
  kind?: string;
  isConnected?: boolean;
  state?: string;
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
interface RegistrationPayload {
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
  const [callState, setCallState] = useState<CallState>("not_started");
  const [currentCall, setCurrentCall] = useState<string | null>(null);
  const [isRegistered, setIsRegistered] = useState(false);
  console.log({ isWebViewReady, Janus });

  const janusDependencies = Janus.useDefaultDependencies({ adapter });

  const [sipCredentials, setSipCredentials] = useState<RegistrationPayload>({});

  // Function to send messages to WebView with retry mechanism
  const sendToWebViewParent = useCallback(
    (message: WebViewMessage, retryCount = 3) => {
      try {
        (
          window as unknown as {
            ReactNativeWebView?: { postMessage: (message: string) => void };
          }
        ).ReactNativeWebView?.postMessage(JSON.stringify(message));
      } catch (error) {
        console.error("Error sending message to WebView:", error);
        if (retryCount > 0) {
          setTimeout(() => sendToWebViewParent(message, retryCount - 1), 1000);
        }
      }
    },
    []
  );

  // Function to handle registration
  const handleRegistration = useCallback(
    (params?: RegistrationPayload) => {
      if (!sipPlugin) {
        const error = "SIP plugin not found";
        console.error(error);
        sendToWebViewParent({ type: "REGISTRATION_ERROR", payload: { error } });
        return;
      }

      // Check if already registered
      if (isRegistered) {
        console.log("Already registered with SIP server");
        sendToWebViewParent({
          type: "REGISTRATION_ERROR",
          payload: { error: "Already registered with SIP server" },
        });
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
    [sipPlugin, isRegistered, sipCredentials, sendToWebViewParent]
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
        sendToWebViewParent({
          type: "CALL_ERROR",
          payload: { error, callState: "error" },
        });
        setCallState("error");
        return;
      }

      if (!phoneNumber) {
        const error = "Phone number is required";
        console.error(error);
        sendToWebViewParent({
          type: "CALL_ERROR",
          payload: { error, callState: "error" },
        });
        setCallState("error");
        return;
      }

      // Extract domain from proxy and provide fallback
      const proxyDomain = sipCredentials.proxy?.split("sip:")[1];

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
          sendToWebViewParent({
            type: "CALL_INITIATED",
            payload: {
              phoneNumber,
              callState: "calling",
            },
          });
        },
        error: (error: Error) => {
          console.error("Error creating offer:", error);
          sendToWebViewParent({
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
    [sipPlugin, sipCredentials, sendToWebViewParent]
  );

  // Handle messages from WebView
  useEffect(() => {
    const handleWebViewMessage = (event: MessageEvent) => {
      const message = JSON.parse(event.data as string) as WebViewMessage;
      console.log(message);

      switch (message.type) {
        case "WEBVIEW_READY":
          setIsWebViewReady(true);
          break;
        case "REGISTER_SIP":
          handleRegistration(message.payload as RegistrationPayload);
          break;
        case "UNREGISTER_SIP":
          handleUnregister();
          break;
        case "MAKE_CALL":
          if (!isRegistered) {
            sendToWebViewParent({
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

    window.addEventListener("message", handleWebViewMessage);
    sendToWebViewParent({ type: "REACT_APP_READY", payload: {} });

    return () => {
      window.removeEventListener("message", handleWebViewMessage);
    };
  }, [
    sipPlugin,
    isRegistered,
    currentCall,
    handleRegistration,
    handleUnregister,
    sendToWebViewParent,
    makeCall,
  ]);

  // Handle SIP plugin messages
  const handleSipMessage = useCallback(
    (msg: JanusJS.Message, jsep?: JanusJS.JSEP) => {
      let localCallState = callState;
      const result = msg.result as SipPluginResult;
      console.log(JSON.stringify(msg, null, 2));

      if (result?.event) {
        setCallState(result.event as CallState);
        localCallState = result.event as CallState;
      }

      if (msg.error) {
        setCallState("error");
        sendToWebViewParent({
          type: "SIP_ERROR",
          payload: { error: msg.error, callState: "error" },
        });
        return;
      }

      // Handle registration states
      if (result?.event === "registered") {
        setIsRegistered(true);
      } else if (result?.event === "unregistered") {
        setIsRegistered(false);
      }

      sendToWebViewParent({
        type: "SIP_STATUS",
        payload: {
          status: result?.event || "unknown",
          data: msg,
          callState: localCallState,
        },
      });

      if (jsep) {
        sipPlugin?.handleRemoteJsep({
          jsep,
          success: () => {
            console.log("Remote jsep handled successfully");
            sendToWebViewParent({
              type: "JSEP_SUCCESS",
              payload: {
                callState: "connected",
              },
            });
          },
          error: (error: string) => {
            console.error(error);
            sendToWebViewParent({
              type: "JSEP_ERROR",
              payload: {
                error,
              },
            });
          },
        });
      }
    },
    [callState, sendToWebViewParent, sipPlugin]
  );

  // Initialize Janus with error handling and reconnection
  useEffect(() => {
    let janus: JanusJS.Janus | null = null;
    let reconnectAttempts = 0;
    const MAX_RECONNECT_ATTEMPTS = 3;
    const initializeJanus = () => {
      setCallState("initializing");
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
              sendToWebViewParent({ type: "JANUS_READY", payload: {} });
              reconnectAttempts = 0; // Reset reconnect attempts on successful connection
              attachSipPlugin();
            },
            error: (error: string) => {
              console.error("Error creating Janus session:", error);
              setCallState("error");
              sendToWebViewParent({
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
              sendToWebViewParent({ type: "JANUS_DESTROYED", payload: {} });
              setIsRegistered(false);
              setCallState("destroyed");
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
          sendToWebViewParent({ type: "SIP_READY", payload: {} });
          setCallState("ready");
        },
        error: (error: string) => {
          console.error("Error attaching to SIP plugin:", error);
          sendToWebViewParent({
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
        consentDialog: (on: boolean) => {
          console.log("Consent dialog:", on);
          sendToWebViewParent({
            type: "CONSENT_DIALOG",
            payload: {},
          });
        },
        onlocaltrack: (track: MediaStreamTrack, on: boolean) => {
          console.log("Local track available:", track);
          sendToWebViewParent({
            type: "LOCAL_TRACK_READY",
            payload: { state: JSON.stringify({ track, on }) },
          });
        },
        onremotetrack: (
          track: MediaStreamTrack,
          mid: string,
          on: boolean,
          metadata?: JanusJS.RemoteTrackMetadata
        ) => {
          console.log("Remote track available:", track, mid, on, metadata);
          sendToWebViewParent({
            type: "REMOTE_TRACK_READY",
            payload: { state: JSON.stringify({ track, mid, on, metadata }) },
          });
        },
        oncleanup: () => {
          console.log("SIP plugin cleaned up");
          sendToWebViewParent({ type: "SIP_CLEANUP", payload: {} });
          setCallState("cleaned");
          setCurrentCall(null);
        },
        webrtcState: (isConnected) => {
          console.log("WebRTC state changed:", isConnected);
          sendToWebViewParent({
            type: "WEBRTC_STATE",
            payload: { isConnected },
          });
        },
        mediaState: (
          medium: "audio" | "video",
          receiving: boolean,
          mid?: number
        ) => {
          console.log("Media state changed:", medium, receiving, mid);
          sendToWebViewParent({
            type: "MEDIA_STATE",
            payload: { state: JSON.stringify({ medium, receiving, mid }) },
          });
        },
        slowLink: (uplink: boolean, lost: number, mid: string) => {
          console.log("Slow link:", uplink, lost, mid);
          sendToWebViewParent({
            type: "SLOW_LINK",
            payload: { state: JSON.stringify({ uplink, lost, mid }) },
          });
        },
        iceState: (state) => {
          console.log("ICE state changed:", state);
          sendToWebViewParent({ type: "ICE_STATE", payload: { state } });
        },
      });
    };

    initializeJanus();
    sendToWebViewParent({ type: "APP_MOUNTED", payload: {} });

    return () => {
      sendToWebViewParent({ type: "APP_UNMOUNTED", payload: {} });

      if (sipPlugin) {
        sipPlugin.detach({
          success: () => {
            console.log("SIP plugin detached");
            sendToWebViewParent({ type: "SIP_DETACHED", payload: {} });
          },
          error: (error: string) => {
            console.error("Error detaching SIP plugin:", error);
            sendToWebViewParent({ type: "DETACH_ERROR", payload: { error } });
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
  }, []);

  return <div>WebView Ready - Call State: {callState}</div>;
}

export default App;
