import React, { useEffect, useRef, useState } from 'react';
import Peer from 'simple-peer';
import socket from './socket';

// Main Room component for video/audio streaming and role management
const Room = ({ roomId }) => {
  // State variables for role, peers, streams, UI, etc.
  const [role, setRole] = useState(null); // 'broadcaster' or 'viewer'
  const [peers, setPeers] = useState([]); // List of peer connections
  const [remoteStreams, setRemoteStreams] = useState({}); // Remote user streams
  const [joined, setJoined] = useState(false); // Has the user joined the room
  const [isAudioMuted, setIsAudioMuted] = useState(false); // Audio muted state
  const [isVideoOff, setIsVideoOff] = useState(false); // Video off state
  const [handRaised, setHandRaised] = useState(false); // Has the viewer raised hand
  const userVideoRef = useRef(); // Ref for user's video element
  const userStream = useRef(); // Ref for user's media stream
  const peersRef = useRef([]); // Ref for peer connections
  const [broadcasterId, setBroadcasterId] = useState(null); // Current broadcaster's socket id
  const [raisedHands, setRaisedHands] = useState([]); // List of viewers who raised hand
  const [isApproved, setIsApproved] = useState(false); // Is viewer approved to speak
  const [approvedSpeakers, setApprovedSpeakers] = useState([]); // List of approved speakers
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const screenStreamRef = useRef(null);

  // Handle role selection and join room
  const handleRoleSelect = (selectedRole) => {
    setRole(selectedRole);
    const userName = 'User-' + Date.now();
    socket.emit('BE-join-room', { roomId, userName, role: selectedRole });
    setJoined(true);

    // Get user media (camera/mic)
    navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      .then((stream) => {
        // Disable mic/camera for viewers initially
        if (selectedRole === 'viewer') {
          stream.getAudioTracks().forEach(track => (track.enabled = false));
          stream.getVideoTracks().forEach(track => (track.enabled = false));
        }

        userStream.current = stream;

        if (userVideoRef.current) {
          userVideoRef.current.srcObject = stream;
        }

        setIsAudioMuted(selectedRole === 'viewer');
        setIsVideoOff(selectedRole === 'viewer');
      })
      .catch((err) => {
        console.error('Media error:', err);
        alert('Failed to access camera/mic.');
      });
  };

  // Cleanup on component unmount or leave
  useEffect(() => {
    return () => {
      if (joined) {
        socket.emit('BE-leave-room', { roomId, leaver: socket.id });
        peersRef.current.forEach(({ peer }) => peer.destroy());
        if (userStream.current) userStream.current.getTracks().forEach((t) => t.stop());
        setApprovedSpeakers(prev => prev.filter(id => id !== socket.id));
      }
    };
  }, [joined, roomId]);

  // Listen for role assignment from server
  useEffect(() => {
    const handleAssignRole = ({ role, broadcasterId }) => {
      setRole(role);
      setBroadcasterId(broadcasterId);
    };
    socket.on('FE-assign-role', handleAssignRole);
    return () => socket.off('FE-assign-role', handleAssignRole);
  }, []);

  // Handle user join events and viewer stopped events (for broadcaster)
  useEffect(() => {
    if (!role) return;

    // When a new user joins, broadcaster creates a peer connection
    const handleUserJoin = (users) => {
      if (role !== 'broadcaster') return;
      users.forEach(({ userId }) => {
        if (userId === socket.id || peersRef.current.some(p => p.peerID === userId)) return;
        const peer = createPeer(userId, socket.id, userStream.current);
        peersRef.current.push({ peerID: userId, peer });
        setPeers([...peersRef.current]);
      });
    };
    // Remove from approved speakers if viewer stopped
    const handleViewerStopped = ({ userId }) => {
      setApprovedSpeakers(prev => prev.filter(id => id !== userId));
    };
    socket.on('FE-viewer-stopped', handleViewerStopped);
    socket.on('FE-user-join', handleUserJoin);
    return () => {
      socket.off('FE-viewer-stopped', handleViewerStopped);
      socket.off('FE-user-join', handleUserJoin);
    };
  }, [role]);

  // Handle peer signaling, hand raise, approval, etc.
  useEffect(() => {
    if (!role) return;

    // When receiving a call (peer connection request)
    const handleReceiveCall = ({ signal, from }) => {
      if (peersRef.current.some(p => p.peerID === from)) return;

      const peer = new Peer({
        initiator: false,
        trickle: false,
        stream: userStream.current,
        config: {
          iceServers: [
            { urls: "stun:turn.alpharegiment.in:3478" },
            {
              urls: [
                "turn:turn.alpharegiment.in:3478?transport=udp",
                "turn:turn.alpharegiment.in:3478?transport=tcp",
              ],
              username: "1748689158",
              credential: "BbAUIZlSN7g7YYSiai3wFd3utg=",
            },
            {
              urls: "turns:turn.alpharegiment.in:5349",
              username: "1748689158",
              credential: "BbAUIZlSN7g7YYSiai3wFd3utg=",
            },
          ],
        },
      });

      peer.on('signal', signal => socket.emit('BE-accept-call', { signal, to: from }));
      peer.on('stream', stream => setRemoteStreams(prev => ({ ...prev, [from]: stream })));
      peer.on('error', () => removePeer(from));
      peer.on('close', () => removePeer(from));
      peer.signal(signal);
      peersRef.current.push({ peerID: from, peer });
      setPeers([...peersRef.current]);
    };

    // When a call is accepted, signal the peer
    const handleCallAccepted = ({ signal, answerId }) => {
      const item = peersRef.current.find(p => p.peerID === answerId);
      if (item) item.peer.signal(signal);
    };

    // When a viewer raises hand
    const handleRaisedHand = ({ userId, userName }) => {
      setRaisedHands(prev => prev.some(p => p.userId === userId) ? prev : [...prev, { userId, userName }]);
    };

    // When a viewer is approved to speak
    const handleSpeakerApproved = () => {
      setIsApproved(true);

      if (userStream.current) {
        userStream.current.getAudioTracks().forEach(track => (track.enabled = true));
        userStream.current.getVideoTracks().forEach(track => (track.enabled = true));
        setIsAudioMuted(false);
        setIsVideoOff(false);
      }
    };

    // When a viewer is told to stop speaking
    const handleStopSpeaking = () => {
      if (userStream.current) {
        userStream.current.getAudioTracks().forEach(track => (track.enabled = false));
        userStream.current.getVideoTracks().forEach(track => (track.enabled = false));
      }
      setIsApproved(false);
      setIsAudioMuted(true);
      setIsVideoOff(true);
      setHandRaised(false);
    };

    // When a viewer's request to speak is declined
    const handleDecline = () => {
      setIsApproved(false);
      setIsAudioMuted(true);
      setIsVideoOff(true);
      setHandRaised(false);

      if (userStream.current) {
        userStream.current.getAudioTracks().forEach(track => (track.enabled = false));
        userStream.current.getVideoTracks().forEach(track => (track.enabled = false));
      }
    };

    // Register all socket event listeners
    socket.on('FE-viewer-stop-speaking', handleStopSpeaking);
    socket.on('FE-receive-call', handleReceiveCall);
    socket.on('FE-call-accepted', handleCallAccepted);
    socket.on('FE-raised-hand', handleRaisedHand);
    socket.on('FE-speaker-approved', handleSpeakerApproved);
    socket.on('FE-decline-speaker', handleDecline);

    // Cleanup listeners on unmount
    return () => {
      socket.off('FE-receive-call', handleReceiveCall);
      socket.off('FE-call-accepted', handleCallAccepted);
      socket.off('FE-raised-hand', handleRaisedHand);
      socket.off('FE-speaker-approved', handleSpeakerApproved);
      socket.off('FE-viewer-stop-speaking', handleStopSpeaking);
      socket.off('FE-decline-speaker', handleDecline);
    };
  }, [role]);

  // Create a new peer connection (for broadcaster)
  const createPeer = (userToCall, from, stream) => {
    const peer = new Peer({
      initiator: true,
      trickle: false,
      stream,
      config: {
        iceServers: [
          { urls: "stun:turn.alpharegiment.in:3478" },
          {
            urls: [
              "turn:turn.alpharegiment.in:3478?transport=udp",
              "turn:turn.alpharegiment.in:3478?transport=tcp",
            ],
            username: "1748689158",
            credential: "BbAUIZlSN7g7YYSiai3wFd3utg=",
          },
          {
            urls: "turns:turn.alpharegiment.in:5349",
            username: "1748689158",
            credential: "BbAUIZlSN7g7YYSiai3wFd3utg=",
          },
        ],
      }
    });

    peer.on('signal', signal => socket.emit('BE-call-user', { userToCall, from, signal }));
    peer.on('stream', stream => setRemoteStreams(prev => ({ ...prev, [userToCall]: stream })));
    peer.on('error', () => removePeer(userToCall));
    peer.on('close', () => removePeer(userToCall));
    return peer;
  };

  // Remove a peer connection and its stream
  const removePeer = (peerID) => {
    peersRef.current = peersRef.current.filter(p => p.peerID !== peerID);
    setPeers([...peersRef.current]);
    setRemoteStreams(prev => {
      const updated = { ...prev };
      delete updated[peerID];
      return updated;
    });
  };

  // Toggle user's audio (mute/unmute)
  const toggleAudio = () => {
    if (userStream.current) {
      const track = userStream.current.getAudioTracks()[0];
      if (track) {
        const newMuted = !isAudioMuted;
        track.enabled = !newMuted;
        setIsAudioMuted(newMuted);
      }
    }
  };

  // Toggle user's video (on/off)
  const toggleVideo = () => {
    if (userStream.current) {
      const track = userStream.current.getVideoTracks()[0];
      if (track) {
        const newVideoOff = !isVideoOff;
        track.enabled = !newVideoOff;
        setIsVideoOff(newVideoOff);
      }
    }
  };

  // Stop speaking (viewer disables their stream)
  const stopSpeaking = () => {
    if (userStream.current) {
      userStream.current.getAudioTracks().forEach(track => (track.enabled = false));
      userStream.current.getVideoTracks().forEach(track => (track.enabled = false));
    }
    setIsApproved(false);
    setIsAudioMuted(true);
    setIsVideoOff(true);
    setHandRaised(false);
    socket.emit('BE-stop-speaking', { roomId, userId: socket.id });
  };

  // Start screen sharing
  const startScreenShare = async () => {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      screenStreamRef.current = screenStream;
      setIsScreenSharing(true);

      // Replace tracks in all peer connections
      peersRef.current.forEach(({ peer }) => {
        const sender = peer._pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) {
          sender.replaceTrack(screenStream.getVideoTracks()[0]);
        }
      });

      // Also update broadcaster's own video view
      if (userVideoRef.current) {
        userVideoRef.current.srcObject = screenStream;
      }

      // When screen sharing stops, revert back to camera
      screenStream.getVideoTracks()[0].onended = () => {
        stopScreenShare();
      };
    } catch (err) {
      console.error('Screen share error:', err);
    }
  };

  // Stop screen sharing
  const stopScreenShare = () => {
    const videoTrack = userStream.current?.getVideoTracks()[0];
    if (!videoTrack) return;

    peersRef.current.forEach(({ peer }) => {
      const sender = peer._pc.getSenders().find(s => s.track?.kind === 'video');
      if (sender) {
        sender.replaceTrack(videoTrack);
      }
    });

    if (userVideoRef.current) {
      userVideoRef.current.srcObject = userStream.current;
    }

    screenStreamRef.current?.getTracks().forEach(track => track.stop());
    screenStreamRef.current = null;
    setIsScreenSharing(false);
  };



  // --- UI Rendering ---
  return (
    <div style={{ textAlign: 'center', marginTop: 40 }}>
      <h2>Room: {roomId}</h2>

      {/* Role selection buttons */}
      {!role && (
        <div style={{ margin: '30px 0' }}>
          <button onClick={() => handleRoleSelect('broadcaster')} style={{ marginRight: 16, padding: '12px 24px', fontSize: 16 }}>Start as Broadcaster</button>
          <button onClick={() => handleRoleSelect('viewer')} style={{ padding: '12px 24px', fontSize: 16 }}>Join as Viewer</button>
        </div>
      )}

      {role && <h3>Role: {role}</h3>}

      {/* Broadcaster UI */}
      {role === 'broadcaster' && (
  <div style={{ display: 'flex', alignItems: 'flex-start', position: 'relative' }}>
    {/* Left: Broadcaster content */}
    <div style={{ flex: 1, paddingRight: 240 }}>
      {/* Broadcaster's own video */}
      <video
        ref={userVideoRef}
        autoPlay
        muted
        playsInline
        style={{
          width: '100%',
          maxWidth: 800,
          borderRadius: 8,
          background: '#000',
        }}
      />

      {/* Screen sharing buttons */}
      <div style={{ marginTop: 10 }}>
        {!isScreenSharing ? (
          <button
            onClick={startScreenShare}
            style={{
              padding: '8px 16px',
              background: '#2196F3',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
            }}
          >
            🖥️ Share Screen
          </button>
        ) : (
          <button
            onClick={stopScreenShare}
            style={{
              padding: '8px 16px',
              background: '#f44336',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
            }}
          >
            ❌ Stop Sharing
          </button>
        )}

        {/* Mic and Camera Toggle Buttons */}
        <div style={{ marginTop: 10, display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button
            onClick={toggleAudio}
            style={{
              padding: '8px 16px',
              background: isAudioMuted ? '#ff4444' : '#4CAF50',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
            }}
          >
            {isAudioMuted ? '🔇 Mute' : '🔊 Unmute'}
          </button>
          <button
            onClick={toggleVideo}
            style={{
              padding: '8px 16px',
              background: isVideoOff ? '#ff4444' : '#4CAF50',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
            }}
          >
            {isVideoOff ? '📷 Off' : '📹 On'}
          </button>
        </div>
      </div>

      {/* Approved Speakers List */}
      {approvedSpeakers.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <h4>Currently Speaking</h4>
          {approvedSpeakers.map((userId) => (
            <div
              key={userId}
              style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'center' }}
            >
              <span>{userId}</span>
              <button
                onClick={() => {
                  socket.emit('BE-stop-speaking', { roomId, userId });
                  setApprovedSpeakers((prev) => prev.filter((id) => id !== userId));
                }}
              >
                🛑 Stop Speaking
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Viewer Thumbnails */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 10,
          justifyContent: 'center',
          marginTop: 20,
        }}
      >
        {Object.entries(remoteStreams).map(([userId, stream]) => {
          const raisedUser = raisedHands.find((p) => p.userId === userId);
          const isPendingApproval = raisedUser && !approvedSpeakers.includes(userId);

          return (
            <div key={userId} style={{ position: 'relative' }}>
              <video
                autoPlay
                playsInline
                ref={(el) => el && (el.srcObject = stream)}
                style={{
                  width: 150,
                  height: 100,
                  borderRadius: 8,
                  objectFit: 'cover',
                  backgroundColor: '#000',
                }}
              />
              {(isPendingApproval || approvedSpeakers.includes(userId)) && (
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    backgroundColor: 'rgba(0,0,0,0.6)',
                    color: 'white',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                    alignItems: 'center',
                    padding: 0,
                    margin: 0,
                    borderRadius: 8,
                  }}
                >
                  {isPendingApproval && (
                    <>
                      <div style={{ fontSize: 32 }}>✋</div>
                      <div style={{ marginTop: 8, display: 'flex', gap: 10 }}>
                        <button
                          title="Approve"
                          onClick={() => {
                            setApprovedSpeakers((prev) => [...prev, userId]);
                            socket.emit('BE-approve-speaker', { roomId, userId });
                            setRaisedHands((prev) => prev.filter((p) => p.userId !== userId));
                          }}
                          style={{
                            fontSize: 16,
                            padding: '6px 12px',
                            borderRadius: 6,
                            border: 'none',
                            background: '#4CAF50',
                            color: '#fff',
                            cursor: 'pointer',
                          }}
                        >
                          ✅ Approve
                        </button>
                        <button
                          title="Decline"
                          onClick={() => {
                            socket.emit('BE-decline-speaker', { roomId, userId });
                            setRaisedHands((prev) => prev.filter((p) => p.userId !== userId));
                          }}
                          style={{
                            fontSize: 16,
                            padding: '6px 12px',
                            borderRadius: 6,
                            border: 'none',
                            background: '#f44336',
                            color: '#fff',
                            cursor: 'pointer',
                          }}
                        >
                          ❌ Decline
                        </button>
                      </div>
                    </>
                  )}
                  {approvedSpeakers.includes(userId) && (
                    <button
                      onClick={() => {
                        socket.emit('BE-stop-speaking', { roomId, userId });
                        setApprovedSpeakers((prev) => prev.filter((id) => id !== userId));
                      }}
                      style={{
                        marginTop: 8,
                        fontSize: 16,
                        padding: '6px 12px',
                        borderRadius: 6,
                        border: 'none',
                        background: '#f44336',
                        color: '#fff',
                        cursor: 'pointer',
                      }}
                    >
                      🛑 Stop Speaking
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>

    {/* Right: Sidebar for viewers */}
    <div
  style={{
    position: 'absolute',
    top: 20,
    right: 20,
    width: 260,
    padding: '16px',
    background: '#f9f9f9',
    color: '#333',
    borderRadius: 12,
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.15)',
    maxHeight: '80vh',
    overflowY: 'auto',
    fontFamily: 'sans-serif',
    border: '1px solid #ddd'
  }}
>
  <h4
    style={{
      margin: '0 0 12px',
      fontSize: '16px',
      borderBottom: '1px solid #ddd',
      paddingBottom: 8,
      color: '#222'
    }}
  >
    👥 Viewers <span style={{ fontWeight: 'normal', fontSize: 14 }}>({Object.keys(remoteStreams).length})</span>
  </h4>

  <ul style={{ listStyleType: 'none', padding: 0, margin: 0 }}>
    {Object.keys(remoteStreams).map((userId, index) => (
      <li
        key={userId}
        style={{
          marginBottom: 8,
          padding: '8px 12px',
          background: index % 2 === 0 ? '#ffffff' : '#f1f1f1',
          borderRadius: 6,
          wordBreak: 'break-word',
          fontSize: 13,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          border: '1px solid #eee'
        }}
      >
        <span style={{ fontSize: 14 }}>👤</span>
        <span>{userId}</span>
      </li>
    ))}
  </ul>
</div>


  </div>
)}


      {/* Viewer UI */}
      {role === 'viewer' && (
        <div style={{ position: 'relative', maxWidth: 800, margin: '0 auto' }}>
          {/* Broadcaster's video(s) */}
          <div style={{ width: '100%', backgroundColor: '#000', borderRadius: 8 }}>
            {Object.entries(remoteStreams).map(([id, stream]) => (
              <video key={id} autoPlay playsInline ref={(el) => el && (el.srcObject = stream)} style={{ width: '100%', aspectRatio: '16/9', objectFit: 'contain' }} />
            ))}
            {Object.keys(remoteStreams).length === 0 && (
              <div style={{ width: '100%', aspectRatio: '16/9', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white' }}>
                Waiting for broadcaster...
              </div>
            )}
          </div>
          {/* User's own camera preview and controls */}
          <div style={{
            position: 'absolute', bottom: 20, right: 20, width: 200, height: 150, borderRadius: 8, overflow: 'hidden',
            border: '2px solid white', backgroundColor: '#000'
          }}>
            <video ref={userVideoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />
            <div style={{
              position: 'absolute', bottom: 0, left: 0, right: 0, background: 'rgba(0,0,0,0.7)', color: 'white',
              textAlign: 'center', padding: '4px', fontSize: '12px'
            }}>
              Your Camera
            </div>
            {/* Controls for mic/camera/raise hand/stop speaking */}
            <div style={{
              position: 'absolute', top: 8, right: 8, display: 'flex',
              flexDirection: 'row', gap: '8px'
            }}>
              {isApproved ? (
                <>
                  {/* Mic Toggle */}
                  <button
                    onClick={toggleAudio}
                    style={{
                      width: 32, height: 32, borderRadius: '50%', border: 'none',
                      background: isAudioMuted ? '#ff4444' : '#4CAF50',
                      color: 'white', cursor: 'pointer', fontSize: '16px'
                    }}
                  >
                    {isAudioMuted ? '🔇' : '🔊'}
                  </button>

                  {/* Camera Toggle */}
                  <button
                    onClick={toggleVideo}
                    style={{
                      width: 32, height: 32, borderRadius: '50%', border: 'none',
                      background: isVideoOff ? '#ff4444' : '#4CAF50',
                      color: 'white', cursor: 'pointer', fontSize: '16px'
                    }}
                  >
                    {isVideoOff ? '📷' : '📹'}
                  </button>

                  {/* Stop Speaking */}
                  <button
                    onClick={stopSpeaking}
                    style={{
                      width: 'auto', padding: '4px 12px', borderRadius: '12px', border: 'none',
                      background: '#f44336', color: 'white', cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px'
                    }}
                  >
                    🛑 Stop Speaking
                  </button>
                </>
              ) : (
                <button
                  disabled={handRaised}
                  onClick={() => {
                    if (!handRaised) {
                      socket.emit('BE-raise-hand', {
                        roomId,
                        userId: socket.id,
                        userName: 'User ' + socket.id,
                      });
                      setHandRaised(true);
                    }
                  }}
                  style={{
                    width: 'auto', padding: '4px 12px', borderRadius: '12px', border: 'none',
                    background: '#ffc107', color: 'black', cursor: handRaised ? 'not-allowed' : 'pointer',
                    opacity: handRaised ? 0.5 : 1,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px'
                  }}
                >
                  🎤 Request to Speak
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Room;
