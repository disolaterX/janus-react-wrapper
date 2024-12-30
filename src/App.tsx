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
  // Add new fields for SIP events
  from?: string;
  hasAudio?: boolean;
  hasVideo?: boolean;
  callId?: string;
  reason?: string;
  code?: number;
  // Add fields for media tracks
  trackId?: string;
  mid?: string;
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

// Add SipPlugin type that extends PluginHandle
interface SipPlugin extends JanusJS.PluginHandle {
  callId?: string;
  doAudio?: boolean;
  doVideo?: boolean;
}

// Add track management state
interface TrackState {
  [key: string]: MediaStream;
}

// Add styles at the top of the file
const styles = {
  sipContainer: {
    display: "flex",
    flexDirection: "column" as const,
    height: "100vh",
    padding: "20px",
    gap: "20px",
  },
  statusBar: {
    padding: "10px",
    backgroundColor: "#f5f5f5",
    borderRadius: "4px",
  },
  videoContainer: {
    display: "flex",
    flex: 1,
    gap: "20px",
    minHeight: "400px",
  },
  videoBox: {
    flex: 1,
    backgroundColor: "#000",
    borderRadius: "8px",
    overflow: "hidden",
    position: "relative" as const,
  },
  video: {
    width: "100%",
    height: "100%",
    objectFit: "cover" as const,
  },
  noVideo: {
    position: "absolute" as const,
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    color: "#fff",
    textAlign: "center" as const,
  },
  controls: {
    display: "flex",
    gap: "10px",
    justifyContent: "center",
  },
  button: {
    padding: "10px 20px",
    borderRadius: "4px",
    border: "none",
    backgroundColor: "#007bff",
    color: "#fff",
    cursor: "pointer",
    ":hover": {
      backgroundColor: "#0056b3",
    },
  },
};

function App() {
  const [sipPlugin, setSipPlugin] = useState<SipPlugin | null>(null);
  // const [isWebViewReady, setIsWebViewReady] = useState(false);
  const [callState, setCallState] = useState<CallState>("not_started");
  const [currentCall, setCurrentCall] = useState<string | null>(null);
  const [isRegistered, setIsRegistered] = useState(false);
  const [localTracks, setLocalTracks] = useState<TrackState>({});
  const [remoteTracks, setRemoteTracks] = useState<TrackState>({});
  const [localVideos, setLocalVideos] = useState(0);
  const [remoteVideos, setRemoteVideos] = useState(0);
  // console.log({ isWebViewReady, Janus });

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

      // Set audio properties
      sipPlugin.doAudio = true;
      sipPlugin.doVideo = false;

      sipPlugin.createOffer({
        tracks: [
          { type: "audio", capture: true, recv: true },
          // Uncomment below if you want video
          // { type: "video", capture: true, recv: true }
        ],
        trickle: true,
        success: (jsep: JanusJS.JSEP) => {
          sipPlugin.send({
            message: {
              request: "call",
              uri: `sip:${phoneNumber}@${proxyDomain}`,
              // Add headers for better compatibility
              headers: {
                "User-Agent": sipCredentials.userAgent || "Janus WebRTC Client",
                "X-Call-Type": "audio",
              },
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
          // setIsWebViewReady(true);
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
      const result = msg.result as SipPluginResult;
      console.log(JSON.stringify(msg, null, 2));

      if (result?.event) {
        setCallState(result.event as CallState);
      }

      if (msg.error) {
        setCallState("error");
        sendToWebViewParent({
          type: "SIP_ERROR",
          payload: { error: msg.error, callState: "error" },
        });
        return;
      }

      // Handle various SIP events
      if (result?.event) {
        switch (result.event) {
          case "registered":
            setIsRegistered(true);
            sendToWebViewParent({
              type: "REGISTRATION_SUCCESS",
              payload: { status: "registered" },
            });
            break;
          case "unregistered":
            setIsRegistered(false);
            sendToWebViewParent({
              type: "UNREGISTERED",
              payload: { status: "unregistered" },
            });
            break;
          case "calling":
            sendToWebViewParent({
              type: "CALLING",
              payload: { status: "calling" },
            });
            break;
          case "incomingcall": {
            // Handle incoming call
            const callId = msg["call_id"] as string;
            if (sipPlugin) {
              sipPlugin.callId = callId;
            }

            // Check what has been negotiated
            let doAudio = true,
              doVideo = false;
            if (jsep && jsep.sdp) {
              doAudio = jsep.sdp.indexOf("m=audio ") > -1;
              doVideo = jsep.sdp.indexOf("m=video ") > -1;
            }

            sendToWebViewParent({
              type: "INCOMING_CALL",
              payload: {
                from: result["username"] as string,
                hasAudio: doAudio,
                hasVideo: doVideo,
                callId: callId,
              },
            });
            break;
          }
          case "accepting":
            // Response to an offerless INVITE
            sendToWebViewParent({
              type: "ACCEPTING",
              payload: { status: "accepting" },
            });
            break;
          case "progress":
            // Early media
            sendToWebViewParent({
              type: "CALL_PROGRESS",
              payload: { status: "progress" },
            });
            if (jsep) {
              sipPlugin?.handleRemoteJsep({ jsep });
            }
            break;
          case "accepted":
            sendToWebViewParent({
              type: "CALL_ACCEPTED",
              payload: { status: "accepted" },
            });
            if (jsep) {
              sipPlugin?.handleRemoteJsep({ jsep });
            }
            break;
          case "hangup":
            setCurrentCall(null);
            setCallState("ended");
            sendToWebViewParent({
              type: "CALL_ENDED",
              payload: {
                reason: result["reason"] as string,
                code: result["code"] as number,
              },
            });
            break;
        }
      }

      // Handle JSEP
      if (jsep) {
        console.log("Handling JSEP", jsep);
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
            console.error("JSEP error:", error);
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
          setSipPlugin(pluginHandle as SipPlugin);
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
            payload: { state: on ? "on" : "off" },
          });
        },
        onlocaltrack: (track: MediaStreamTrack, on: boolean) => {
          console.log("Local track " + (on ? "added" : "removed") + ":", track);
          const trackId = track.id.replace(/[{}]/g, "");

          if (!on) {
            // Track removed, get rid of the stream and the rendering
            const stream = localTracks[trackId];
            if (stream) {
              try {
                const tracks = stream.getTracks();
                tracks.forEach((track) => track.stop());
              } catch (e) {
                console.error("Error stopping tracks:", e);
              }
            }

            if (track.kind === "video") {
              setLocalVideos((prev) => prev - 1);
            }

            setLocalTracks((prev) => {
              const newTracks = { ...prev };
              delete newTracks[trackId];
              return newTracks;
            });

            return;
          }

          // If we're here, a new track was added
          const stream = new MediaStream([track]);
          setLocalTracks((prev) => ({
            ...prev,
            [trackId]: stream,
          }));

          if (track.kind === "video") {
            setLocalVideos((prev) => prev + 1);
          }

          sendToWebViewParent({
            type: "LOCAL_TRACK_READY",
            payload: {
              kind: track.kind,
              trackId,
              state: on ? "added" : "removed",
            },
          });
        },
        onremotetrack: (track: MediaStreamTrack, mid: string, on: boolean) => {
          console.log(
            "Remote track (mid=" +
              mid +
              ") " +
              (on ? "added" : "removed") +
              ":",
            track
          );

          if (!on) {
            if (track.kind === "video") {
              setRemoteVideos((prev) => prev - 1);
            }

            setRemoteTracks((prev) => {
              const newTracks = { ...prev };
              delete newTracks[mid];
              return newTracks;
            });

            return;
          }

          // If we're here, a new track was added
          const stream = new MediaStream([track]);
          setRemoteTracks((prev) => ({
            ...prev,
            [mid]: stream,
          }));

          if (track.kind === "video") {
            setRemoteVideos((prev) => prev + 1);
          }

          sendToWebViewParent({
            type: "REMOTE_TRACK_READY",
            payload: {
              kind: track.kind,
              mid,
              state: on ? "added" : "removed",
            },
          });
        },
        oncleanup: () => {
          console.log("SIP plugin cleaned up");
          setLocalTracks({});
          setRemoteTracks({});
          setLocalVideos(0);
          setRemoteVideos(0);
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

  return (
    <div style={styles.sipContainer}>
      <div style={styles.statusBar}>
        WebView Ready - Call State: {callState}
      </div>

      <div style={styles.videoContainer}>
        <div style={styles.videoBox}>
          {/* Add audio elements for local tracks */}
          {Object.entries(localTracks).map(([trackId, stream]) => {
            const track = stream.getTracks()[0];
            if (track.kind === "audio") {
              return (
                <audio
                  key={trackId}
                  autoPlay
                  playsInline
                  muted // Local audio should be muted to prevent echo
                  ref={(el) => {
                    if (el) {
                      el.srcObject = stream;
                    }
                  }}
                />
              );
            }
            return null;
          })}

          {localVideos === 0 ? (
            <div style={styles.noVideo}>No local video</div>
          ) : (
            Object.entries(localTracks).map(([trackId, stream]) => {
              const track = stream.getTracks()[0];
              if (track.kind === "video") {
                return (
                  <video
                    key={trackId}
                    style={styles.video}
                    autoPlay
                    playsInline
                    muted
                    ref={(el) => {
                      if (el) {
                        el.srcObject = stream;
                      }
                    }}
                  />
                );
              }
              return null;
            })
          )}
        </div>

        <div style={styles.videoBox}>
          {/* Add audio elements for remote tracks */}
          {Object.entries(remoteTracks).map(([mid, stream]) => {
            const track = stream.getTracks()[0];
            if (track.kind === "audio") {
              return (
                <audio
                  key={mid}
                  autoPlay
                  playsInline
                  ref={(el) => {
                    if (el) {
                      el.srcObject = stream;
                    }
                  }}
                />
              );
            }
            return null;
          })}

          {remoteVideos === 0 ? (
            <div style={styles.noVideo}>No remote video</div>
          ) : (
            Object.entries(remoteTracks).map(([mid, stream]) => {
              const track = stream.getTracks()[0];
              if (track.kind === "video") {
                return (
                  <video
                    key={mid}
                    style={styles.video}
                    autoPlay
                    playsInline
                    ref={(el) => {
                      if (el) {
                        el.srcObject = stream;
                      }
                    }}
                  />
                );
              }
              return null;
            })
          )}
        </div>
      </div>

      <div style={styles.controls}>
        <button
          style={styles.button}
          onClick={() => {
            makeCall("9999202499");
          }}
        >
          Make Call
        </button>
        <button
          style={styles.button}
          onClick={() => {
            handleRegistration({
              username: "sip:su_251950@103.230.84.119:5080",
              displayName: "su_251950",
              authuser: "su_251950",
              secret: "hJhGU0lI",
              proxy: "sip:103.230.84.119:5080",
              userAgent: "com.superfone",
            });
          }}
        >
          Register
        </button>
      </div>
    </div>
  );
}

export default App;
