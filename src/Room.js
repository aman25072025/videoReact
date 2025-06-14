import React, { useEffect, useRef, useState } from 'react';
import Peer from 'simple-peer';
import socket from './socket';

const Room = ({ roomId }) => {
  const [role, setRole] = useState(null);
  const [peers, setPeers] = useState([]); // Array of { peerID, peer }
  const [remoteStreams, setRemoteStreams] = useState({}); // peerID: stream
  const [joined, setJoined] = useState(false);
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const userVideoRef = useRef();
  const userStream = useRef();
  const peersRef = useRef([]);
  const [broadcasterId, setBroadcasterId] = useState(null);
  const [activeSpeaker, setActiveSpeaker] = useState(null);
  const [raisedHands, setRaisedHands] = useState([]);
  
  const handleRoleSelect = (selectedRole) => {
    setRole(selectedRole);
    const userName = 'user' + Date.now();
    socket.emit('BE-join-room', { roomId, userName, role: selectedRole });
    setJoined(true);

    if (selectedRole === 'broadcaster' || selectedRole === 'viewer') {
      navigator.mediaDevices
        .getUserMedia({
          video: true,
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
            sampleRate: 48000,
            sampleSize: 16
          }
        })
        .then((stream) => {
          console.log('Got media stream:', stream.getAudioTracks().length > 0 ? 'Has audio' : 'No audio');
          if (stream.getAudioTracks().length > 0) {
            console.log('Audio track settings:', stream.getAudioTracks()[0].getSettings());
          }
          userStream.current = stream;
          if (userVideoRef.current) {
            userVideoRef.current.srcObject = stream;
          }
        })
        .catch((err) => {
          console.error('Error accessing media devices:', err);
          alert('Failed to access camera/microphone. Please ensure you have granted permissions.');
        });
    }
  };

  useEffect(() => {
    return () => {
      if (joined) {
        socket.emit('BE-leave-room', { roomId, leaver: socket.id });
        peersRef.current.forEach(({ peer }) => peer.destroy());
        if (userStream.current) {
          userStream.current.getTracks().forEach((t) => t.stop());
        }
      }
    };
  }, [joined, roomId]);

  useEffect(() => {
    const handleAssignRole = ({ role, broadcasterId }) => {
      setRole(role);
      setBroadcasterId(broadcasterId);
      if (role === 'viewer') {
        navigator.mediaDevices
          .getUserMedia({
            video: true,
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
              channelCount: 1,
              sampleRate: 48000,
              sampleSize: 16
            }
          })
          .then((stream) => {
            console.log('Got media stream:', stream.getAudioTracks().length > 0 ? 'Has audio' : 'No audio');
            if (stream.getAudioTracks().length > 0) {
              console.log('Audio track settings:', stream.getAudioTracks()[0].getSettings());
            }
            userStream.current = stream;
            if (userVideoRef.current) {
              userVideoRef.current.srcObject = stream;
            }
          })
          .catch((err) => {
            console.error('Error accessing media devices:', err);
            alert('Failed to access camera/microphone. Please ensure you have granted permissions.');
          });
      }
    };
    socket.on('FE-assign-role', handleAssignRole);
    return () => socket.off('FE-assign-role', handleAssignRole);
  }, []);

  useEffect(() => {
    if (!role) return;

    const handleUserJoin = (users) => {
      if (role !== 'broadcaster') return;

      users.forEach(({ userId }) => {
        if (
          userId === socket.id ||
          peersRef.current.some((p) => p.peerID === userId)
        )
          return;

        const peer = createPeer(userId, socket.id, userStream.current);
        peersRef.current.push({ peerID: userId, peer });
        setPeers([...peersRef.current]);
      });
    };

    socket.on('FE-user-join', handleUserJoin);
    return () => socket.off('FE-user-join', handleUserJoin);
  }, [role]);

  useEffect(() => {
    if (!role) return;

    const handleReceiveCall = ({ signal, from }) => {
      if (peersRef.current.some((p) => p.peerID === from)) return;
      console.log('Received call from:', from, 'Current role:', role);

      // For viewer, we need to create a new peer with our stream
      if (role === 'viewer' && userStream.current) {
        console.log('Viewer creating peer with stream:', userStream.current.getAudioTracks().length > 0 ? 'Has audio' : 'No audio');

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

        peer.on('signal', (signal) => {
          console.log('Viewer sending signal to broadcaster:', from);
          socket.emit('BE-accept-call', { signal, to: from });
        });

        peer.on('stream', (stream) => {
          console.log('Viewer received stream from broadcaster:', stream.getAudioTracks().length > 0 ? 'Has audio' : 'No audio');
          setRemoteStreams((prev) => ({ ...prev, [from]: stream }));
        });

        peer.on('error', (err) => {
          console.error('Viewer peer error:', err);
          removePeer(from);
        });

        peer.on('close', () => {
          console.log('Viewer peer connection closed');
          removePeer(from);
        });

        // Signal the peer with the incoming signal
        peer.signal(signal);
        peersRef.current.push({ peerID: from, peer });
        setPeers([...peersRef.current]);
      }
    };

    const handleCallAccepted = ({ signal, answerId }) => {
      console.log('Call accepted by:', answerId);
      const item = peersRef.current.find((p) => p.peerID === answerId);
      if (item) {
        console.log('Signaling peer with answer');
        item.peer.signal(signal);
      }
    };

    socket.on('FE-receive-call', handleReceiveCall);
    socket.on('FE-call-accepted', handleCallAccepted);

    return () => {
      socket.off('FE-receive-call', handleReceiveCall);
      socket.off('FE-call-accepted', handleCallAccepted);
    };
  }, [role]);

  const createPeer = (userToCall, from, stream) => {
    console.log('Creating peer for:', userToCall, 'Stream has audio:', stream.getAudioTracks().length > 0);
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
      },
    });

    peer.on('signal', (signal) => {
      console.log('Broadcaster sending signal to viewer:', userToCall);
      socket.emit('BE-call-user', { userToCall, from, signal });
    });

    peer.on('stream', (stream) => {
      console.log('Broadcaster received stream from viewer:', stream.getAudioTracks().length > 0 ? 'Has audio' : 'No audio');
      setRemoteStreams((prev) => ({ ...prev, [userToCall]: stream }));
    });

    peer.on('error', (err) => {
      console.error('Broadcaster peer error:', err);
      removePeer(userToCall);
    });

    peer.on('close', () => {
      console.log('Broadcaster peer connection closed');
      removePeer(userToCall);
    });

    return peer;
  };

  const removePeer = (peerID) => {
    console.log('Removing peer:', peerID);
    peersRef.current = peersRef.current.filter((p) => p.peerID !== peerID);
    setPeers([...peersRef.current]);
    setRemoteStreams((prev) => {
      const updated = { ...prev };
      delete updated[peerID];
      return updated;
    });
  };

  const toggleAudio = () => {
    if (userStream.current) {
      const audioTrack = userStream.current.getAudioTracks()[0];
      if (audioTrack) {
        const newMutedState = !isAudioMuted;
        audioTrack.enabled = !newMutedState; // Enable track when not muted
        setIsAudioMuted(newMutedState);

        // Update all peer connections
        peersRef.current.forEach(({ peer }) => {
          if (peer._pc) {
            const senders = peer._pc.getSenders();
            const audioSender = senders.find(sender => sender.track?.kind === 'audio');
            if (audioSender) {
              audioSender.track.enabled = !newMutedState;
            }
          }
        });
      }
    }
  };

  const toggleVideo = () => {
    if (userStream.current) {
      const videoTrack = userStream.current.getVideoTracks()[0];
      if (videoTrack) {
        const newVideoOffState = !isVideoOff;
        videoTrack.enabled = !newVideoOffState; // Enable track when not off
        setIsVideoOff(newVideoOffState);

        // Update all peer connections
        peersRef.current.forEach(({ peer }) => {
          if (peer._pc) {
            const senders = peer._pc.getSenders();
            const videoSender = senders.find(sender => sender.track?.kind === 'video');
            if (videoSender) {
              videoSender.track.enabled = !newVideoOffState;
            }
          }
        });
      }
    }
  };

  return (
    <div style={{ textAlign: 'center', marginTop: 40 }}>
      <h2>Room: {roomId}</h2>

      {!role && (
        <div style={{ margin: '30px 0' }}>
          <button
            onClick={() => handleRoleSelect('broadcaster')}
            style={{ marginRight: 16, padding: '12px 24px', fontSize: 16 }}
          >
            Start as Broadcaster
          </button>
          <button
            onClick={() => handleRoleSelect('viewer')}
            style={{ padding: '12px 24px', fontSize: 16 }}
          >
            Join as Viewer
          </button>
        </div>
      )}

      {role && <h3>Role: {role}</h3>}

      {role === 'broadcaster' && (
        <div>
          <div style={{ position: 'relative', maxWidth: 800, margin: '0 auto' }}>
            <video
              ref={userVideoRef}
              autoPlay
              muted
              playsInline
              style={{
                width: '100%',
                aspectRatio: '16/9',
                borderRadius: 8,
                backgroundColor: '#000'
              }}
            />
            {/* Control buttons for broadcaster */}
            <div style={{
              position: 'absolute',
              bottom: 20,
              left: '50%',
              transform: 'translateX(-50%)',
              display: 'flex',
              gap: '16px',
              background: 'rgba(0,0,0,0.5)',
              padding: '8px 16px',
              borderRadius: '24px'
            }}>
              <button
                onClick={toggleAudio}
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: '50%',
                  border: 'none',
                  background: isAudioMuted ? '#ff4444' : '#4CAF50',
                  color: 'white',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '20px'
                }}
                title={isAudioMuted ? 'Unmute' : 'Mute'}
              >
                {isAudioMuted ? '🔇' : '🔊'}
              </button>
              <button
                onClick={toggleVideo}
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: '50%',
                  border: 'none',
                  background: isVideoOff ? '#ff4444' : '#4CAF50',
                  color: 'white',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '20px'
                }}
                title={isVideoOff ? 'Turn on camera' : 'Turn off camera'}
              >
                {isVideoOff ? '📷' : '📹'}
              </button>
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 10,
              justifyContent: 'center',
              marginTop: 20
            }}
          >
            {Object.entries(remoteStreams).map(([id, stream]) => (
              <video
                key={id}
                autoPlay
                playsInline
                ref={(el) => {
                  if (el && stream) el.srcObject = stream;
                }}
                style={{
                  width: 150,
                  height: 100,
                  border: '1px solid #ccc',
                  borderRadius: 8,
                }}
              />
            ))}
          </div>
        </div>
      )}

      {role === 'viewer' && (
        <div style={{ position: 'relative', maxWidth: 800, margin: '0 auto' }}>
          {/* Main broadcast stream */}
          <div style={{ width: '100%', backgroundColor: '#000', borderRadius: 8, overflow: 'hidden' }}>
            {Object.entries(remoteStreams).map(([id, stream]) => (
              <video
                key={id}
                autoPlay
                playsInline
                ref={(el) => {
                  if (el && stream) el.srcObject = stream;
                }}
                style={{
                  width: '100%',
                  aspectRatio: '16/9',
                  objectFit: 'contain'
                }}
              />
            ))}
            {Object.keys(remoteStreams).length === 0 && (
              <div style={{
                width: '100%',
                aspectRatio: '16/9',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'white',
                backgroundColor: '#000'
              }}>
                No stream received yet. Waiting for broadcaster...
              </div>
            )}
          </div>

          {/* Self view in bottom right */}
          <div style={{
            position: 'absolute',
            bottom: 20,
            right: 20,
            width: 200,
            height: 150,
            borderRadius: 8,
            overflow: 'hidden',
            border: '2px solid white',
            boxShadow: '0 0 10px rgba(0,0,0,0.5)',
            backgroundColor: '#000'
          }}>
            <video
              ref={userVideoRef}
              autoPlay
              playsInline
              muted
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                transform: 'scaleX(-1)' // Mirror the self view
              }}
            />
            <div style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              background: 'rgba(0,0,0,0.7)',
              color: 'white',
              textAlign: 'center',
              padding: '4px',
              fontSize: '12px'
            }}>
              Your Camera
            </div>
            {/* Control buttons */}
            <div style={{
              position: 'absolute',
              top: 8,
              right: 8,
              display: 'flex',
              gap: '8px'
            }}>
              <button
                onClick={toggleAudio}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  border: 'none',
                  background: isAudioMuted ? '#ff4444' : '#4CAF50',
                  color: 'white',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '16px'
                }}
                title={isAudioMuted ? 'Unmute' : 'Mute'}
              >
                {isAudioMuted ? '🔇' : '🔊'}
              </button>
              <button
                onClick={toggleVideo}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  border: 'none',
                  background: isVideoOff ? '#ff4444' : '#4CAF50',
                  color: 'white',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '16px'
                }}
                title={isVideoOff ? 'Turn on camera' : 'Turn off camera'}
              >
                {isVideoOff ? '📷' : '📹'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Room;
