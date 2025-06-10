import React, { useEffect, useRef, useState } from 'react';
import Peer from 'simple-peer';
import socket from './socket';

const Room = ({ roomId }) => {
  const [role, setRole] = useState(null);
  const [peers, setPeers] = useState([]);
  const [remoteStreams, setRemoteStreams] = useState({});
  const [viewerStreams, setViewerStreams] = useState({});
  const [joined, setJoined] = useState(false);
  const userVideoRef = useRef();
  const viewerSelfVideoRef = useRef();
  const userStream = useRef();
  const peersRef = useRef([]);
  const [broadcasterId, setBroadcasterId] = useState(null);
  const [selfViewReady, setSelfViewReady] = useState(false);

  const handleRoleSelect = async (selectedRole) => {
    try {
      setRole(selectedRole);
      const userName = 'user' + Date.now();
      socket.emit('BE-join-room', { roomId, userName, role: selectedRole });
      setJoined(true);
    } catch (err) {
      console.error("Error joining room:", err);
    }
  };

  useEffect(() => {
    if (role === 'viewer') {
      // First try to access camera
      navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        .then((stream) => {
          userStream.current = stream;
          // Remove storing in remoteStreams as it's meant for remote streams
          if (viewerSelfVideoRef.current) {
            viewerSelfVideoRef.current.srcObject = stream;
            setSelfViewReady(true);
          }
        })
        .catch((err) => {
          console.error("Error accessing viewer's camera:", err);
        });
    }
  }, [role]);

  useEffect(() => {
    return () => {
      if (joined) {
        socket.emit('BE-leave-room', { roomId, leaver: socket.id });
        peersRef.current.forEach(({ peer }) => peer.destroy());
      }
    };
  }, [joined, roomId]);

  useEffect(() => {
    const handleAssignRole = ({ role, broadcasterId }) => {
      setRole(role);
      setBroadcasterId(broadcasterId);
      if (role === 'broadcaster') {
        navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then((stream) => {
          userStream.current = stream;
          if (userVideoRef.current) userVideoRef.current.srcObject = stream;
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
        if (userId === socket.id || peersRef.current.some(p => p.peerID === userId)) return;

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
      if (peersRef.current.some(p => p.peerID === from)) return;

      const peer = addPeer(signal, from);
      peersRef.current.push({ peerID: from, peer });
      setPeers([...peersRef.current]);
    };

    const handleCallAccepted = ({ signal, answerId }) => {
      const item = peersRef.current.find(p => p.peerID === answerId);
      if (item) item.peer.signal(signal);
    };

    socket.on('FE-receive-call', handleReceiveCall);
    socket.on('FE-call-accepted', handleCallAccepted);

    return () => {
      socket.off('FE-receive-call', handleReceiveCall);
      socket.off('FE-call-accepted', handleCallAccepted);
    };
  }, [role]);

  const createPeer = (userToCall, from, stream) => {
    const peer = new Peer({
      initiator: true,
      trickle: false,
      stream,
      config: {
        iceServers: [
          { "urls": "stun:stun.l.google.com:19302" },
          { "urls": "stun:turn.alpharegiment.in:3478" },
          {
            "urls":
              ["turn:turn.alpharegiment.in:3478?transport=udp",
                "turn:turn.alpharegiment.in:3478?transport=tcp"
              ], "username": "1749567761", "credential": "5/y8+BRb3gvHGBmAat6BdUoo+/Q="
          }, { "urls": "turns:turn.alpharegiment.in:5349", "username": "1749567761", "credential": "5/y8+BRb3gvHGBmAat6BdUoo+/Q=" }]
      }
    });

    peer.on('signal', (signal) => {
      socket.emit('BE-call-user', { userToCall, from, signal });
    });

    peer.on('stream', (stream) => {
      // Broadcaster receives viewer's stream
      if (role === 'broadcaster') {
        setViewerStreams(prev => ({ ...prev, [userToCall]: stream }));
      }
    });

    peer.on('error', console.error);
    peer.on('close', () => {
      removePeer(userToCall);
      if (role === 'broadcaster') {
        setViewerStreams(prev => {
          const updated = { ...prev };
          delete updated[userToCall];
          return updated;
        });
      }
    });
    return peer;
  };

  const addPeer = (incomingSignal, from) => {
    const peer = new Peer({
      initiator: false,
      trickle: false,
      config: {
        iceServers: [
          { "urls": "stun:stun.l.google.com:19302" },
          { "urls": "stun:turn.alpharegiment.in:3478" },
          {
            "urls":
              ["turn:turn.alpharegiment.in:3478?transport=udp",
                "turn:turn.alpharegiment.in:3478?transport=tcp"
              ], "username": "1749567761", "credential": "5/y8+BRb3gvHGBmAat6BdUoo+/Q="
          }, { "urls": "turns:turn.alpharegiment.in:5349", "username": "1749567761", "credential": "5/y8+BRb3gvHGBmAat6BdUoo+/Q=" }]
      }
    });

    peer.on('signal', (signal) => {
      socket.emit('BE-accept-call', { signal, to: from });
    });

    peer.on('stream', (stream) => {
      setRemoteStreams(prev => ({ ...prev, [from]: stream }));
    });

    peer.on('error', console.error);
    peer.on('close', () => removePeer(from));

    peer.signal(incomingSignal);
    return peer;
  };

  const removePeer = (peerID) => {
    peersRef.current = peersRef.current.filter(p => p.peerID !== peerID);
    setPeers([...peersRef.current]);
    setRemoteStreams(prev => {
      const updated = { ...prev };
      delete updated[peerID];
      return updated;
    });
  };

  return (
    <div style={{
      textAlign: 'center',
      marginTop: 40,
      padding: '0 20px'
    }}>
      <h2>Room: {roomId}</h2>
      {!role && (
        <div style={{ margin: '30px 0' }}>
          <button onClick={() => handleRoleSelect('broadcaster')}>Broadcaster</button>
          <button onClick={() => handleRoleSelect('viewer')}>Viewer</button>
        </div>
      )}
      {role && <h3>Role: {role}</h3>}

      {/* Broadcaster View */}
      {role === 'broadcaster' && (
        <div style={{
          position: 'relative',
          display: 'inline-block',
          width: '100%',
          maxWidth: '800px'
        }}>
          <video
            ref={userVideoRef}
            autoPlay
            muted
            playsInline
            style={{
              width: '100%',
              borderRadius: '8px',
              backgroundColor: '#000',
              aspectRatio: '16/9'
            }}
          />

          {/* Viewer thumbnails */}
          <div style={{
            position: 'absolute',
            bottom: '20px',
            right: '20px',
            display: 'flex',
            gap: '10px',
            flexDirection: 'row-reverse'
          }}>
            {Object.entries(viewerStreams).map(([id, stream]) => (
              <div key={id} style={{
                width: '120px',
                height: '90px',
                borderRadius: '4px',
                overflow: 'hidden',
                border: '2px solid white'
              }}>
                <video
                  autoPlay
                  playsInline
                  ref={el => el && (el.srcObject = stream)}
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover'
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {role === 'viewer' && (
        <div style={{
          position: 'relative',
          display: 'inline-block',
          width: '100%',
          maxWidth: '800px'
        }}>
          {/* Main broadcast stream */}
          <div style={{
            width: '100%',
            backgroundColor: '#000',
            borderRadius: '8px',
            aspectRatio: '16/9',
            overflow: 'hidden'
          }}>
            {Object.keys(remoteStreams).length > 0 ? (
              Object.entries(remoteStreams).map(([id, stream]) => (
                <video
                  key={id}
                  autoPlay
                  playsInline
                  ref={el => el && (el.srcObject = stream)}
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'contain'
                  }}
                />
              ))
            ) : (
              <div style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'white'
              }}>
                Waiting for broadcast to start...
              </div>
            )}
          </div>

          {/* Self-view overlay */}
          <div style={{
            position: 'absolute',
            bottom: '20px',
            right: '20px',
            width: '160px',
            height: '120px',
            borderRadius: '8px',
            overflow: 'hidden',
            border: '2px solid white',
            boxShadow: '0 0 10px rgba(0,0,0,0.5)',
            zIndex: 100
          }}>
            <video
              ref={viewerSelfVideoRef}
              autoPlay
              muted
              playsInline
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                transform: 'scaleX(-1)'
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default Room;

