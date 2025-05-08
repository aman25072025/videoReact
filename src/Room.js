import React, { useEffect, useRef, useState } from 'react';
import Peer from 'simple-peer';
import socket from './socket';

const Room = ({ roomId }) => {
  const [role, setRole] = useState(null); // 'broadcaster' | 'viewer'
  const [peers, setPeers] = useState([]);
  const userVideoRef = useRef();
  const peersRef = useRef([]); // Array of { peerID, peer }
  const userStream = useRef();
  const [broadcasterId, setBroadcasterId] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState({}); // peerID: stream
  const [joined, setJoined] = useState(false);

  // Manual role selection handler
  const handleRoleSelect = (selectedRole) => {
    setRole(selectedRole);
    socket.emit('BE-join-room', { roomId, userName: 'user' + Date.now(), role: selectedRole });
    setJoined(true);
    if (selectedRole === 'broadcaster') {
      navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then((stream) => {
        userVideoRef.current.srcObject = stream;
        userStream.current = stream;
      });
    }
  };

  useEffect(() => {
    // Cleanup on unmount
    return () => {
      if (joined) {
        socket.emit('BE-leave-room', { roomId, leaver: 'user' + Date.now() });
      }
      peersRef.current.forEach(({ peer }) => {
        try {
          if (peer && typeof peer.destroy === 'function') {
            peer.destroy();
          }
        } catch (err) {
          console.error('Error destroying peer:', err);
        }
      });
      peersRef.current = [];
      setPeers([]);
      setRemoteStreams({});
    };
    // eslint-disable-next-line
  }, [roomId]);

  // Handle role assignment
  useEffect(() => {
    const handleAssignRole = ({ role, broadcasterId }) => {
      setRole(role);
      setBroadcasterId(broadcasterId);
      if (role === 'broadcaster') {
        navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then((stream) => {
          userVideoRef.current.srcObject = stream;
          userStream.current = stream;
        });
      }
    };
    socket.on('FE-assign-role', handleAssignRole);
    return () => {
      socket.off('FE-assign-role', handleAssignRole);
    };
  }, []);

  // Handle new users joining
  useEffect(() => {
    if (!role) return;
    const handleUserJoin = (users) => {
      // Only broadcaster creates peers for new viewers
      if (role !== 'broadcaster') return;
      const peersArr = [];
      users.forEach(({ userId }) => {
        if (userId === socket.id) return;
        const peer = createPeer(userId, socket.id, userStream.current);
        peersRef.current.push({ peerID: userId, peer });
        peersArr.push({ peerID: userId, peer });
      });
      setPeers(peersArr);
    };
    socket.on('FE-user-join', handleUserJoin);
    return () => {
      socket.off('FE-user-join', handleUserJoin);
    };
    // eslint-disable-next-line
  }, [role]);

  // Peer signaling logic
  useEffect(() => {
    if (!role) return;

    // Viewer receives call from broadcaster
    const handleReceiveCall = ({ signal, from }) => {
      // Check if a peer for this connection already exists
      const existingPeer = peersRef.current.find(p => p.peerID === from);
      
      if (existingPeer) {
        try {
          // If peer exists but is in a bad state, destroy it
          if (existingPeer.peer.destroyed) {
            existingPeer.peer.destroy();
          }
        } catch (err) {
          console.error('Error handling existing peer:', err);
        }
      }

      // Create or recreate peer
      const peer = addPeer(signal, from, userStream.current);
      
      // Remove any existing peer for this connection
      peersRef.current = peersRef.current.filter(p => p.peerID !== from);
      
      // Add new peer
      peersRef.current.push({ peerID: from, peer });
      setPeers([...peersRef.current]);
    };
    socket.on('FE-receive-call', handleReceiveCall);

    // Viewer receives call accepted from broadcaster
    const handleCallAccepted = ({ signal, answerId }) => {
      const item = peersRef.current.find(p => p.peerID === answerId);
      if (item) {
        try {
          // Comprehensive state check
          if (item.peer.destroyed || item.peer.closed) {
            console.warn(`Peer connection with ${answerId} is in an invalid state`, { 
              destroyed: item.peer.destroyed, 
              closed: item.peer.closed 
            });
            
            // Remove the problematic peer
            peersRef.current = peersRef.current.filter(p => p.peerID !== answerId);
            setPeers([...peersRef.current]);
            return;
          }

          // Attempt to signal with additional safety
          if (item.peer.connecting) {
            console.warn(`Peer ${answerId} is still connecting, delaying signal`);
            setTimeout(() => {
              try {
                item.peer.signal(signal);
              } catch (delayedErr) {
                console.error('Delayed signal error:', delayedErr);
              }
            }, 500);
          } else {
            item.peer.signal(signal);
          }
        } catch (err) {
          console.error(`Error signaling peer ${answerId}:`, err);
          // Remove the problematic peer
          peersRef.current = peersRef.current.filter(p => p.peerID !== answerId);
          setPeers([...peersRef.current]);
        }
      } else {
        console.warn(`No peer found for ${answerId}, potential race condition`);
      }
    };
    socket.on('FE-call-accepted', handleCallAccepted);

    return () => {
      socket.off('FE-receive-call', handleReceiveCall);
      socket.off('FE-call-accepted', handleCallAccepted);
    };
    // eslint-disable-next-line
  }, [role, userStream]);

  // Helper: create peer (broadcaster initiates)
  function createPeer(userToCall, from, stream) {
    console.log(`Creating peer for userToCall: ${userToCall}, from: ${from}, stream: ${!!stream}`);

    // Check if a peer for this connection already exists
    const existingPeer = peersRef.current.find(p => p.peerID === userToCall);
    if (existingPeer) {
      console.warn(`Peer connection already exists for ${userToCall}, destroying existing connection`);
      try {
        existingPeer.peer.destroy();
      } catch (err) {
        console.error('Error destroying existing peer:', err);
      }
      peersRef.current = peersRef.current.filter(p => p.peerID !== userToCall);
      setPeers([...peersRef.current]);
    }

    const peer = new Peer({
      initiator: true,
      trickle: false,
      stream: stream || undefined,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject',
          },
        ],
      },
    });

    // Comprehensive connection tracking
    const connectionLog = {
      created: Date.now(),
      signalReceived: false,
      connected: false,
      streamReceived: false,
      closed: false,
      error: null,
      userToCall,
      from
    };

    peer.on('signal', (signal) => {
      connectionLog.signalReceived = true;
      console.log(`Signal generated for ${userToCall}`, { 
        signal, 
        from,
        existingPeers: peersRef.current.length 
      });
      socket.emit('BE-call-user', { userToCall, from, signal });
    });

    peer.on('connect', () => {
      connectionLog.connected = true;
      console.log(`Peer connection FULLY established with ${userToCall}`, {
        duration: Date.now() - connectionLog.created,
        existingPeers: peersRef.current.length,
        connectionLog
      });
    });

    peer.on('stream', (receivedStream) => {
      connectionLog.streamReceived = true;
      console.log(`Stream received from ${userToCall}`, {
        streamTracks: receivedStream.getTracks().map(t => t.kind),
        existingPeers: peersRef.current.length
      });
      setRemoteStreams((prev) => ({
        ...prev, 
        [userToCall]: receivedStream
      }));
    });

    peer.on('close', () => {
      connectionLog.closed = true;
      console.warn(`Peer connection CLOSED with ${userToCall}`, {
        duration: Date.now() - connectionLog.created,
        existingPeers: peersRef.current.length,
        connectionLog
      });
      
      peersRef.current = peersRef.current.filter((p) => p.peerID !== userToCall);
      setPeers([...peersRef.current]);
      
      setRemoteStreams((prev) => {
        const newStreams = { ...prev };
        delete newStreams[userToCall];
        return newStreams;
      });
    });

    peer.on('error', (err) => {
      connectionLog.error = err.toString();
      console.error(`Comprehensive Peer ERROR with ${userToCall}:`, {
        error: err,
        existingPeers: peersRef.current.length,
        connectionLog
      });

      try {
        peer.destroy();
      } catch (destroyErr) {
        console.error('Error during peer destruction:', destroyErr);
      }

      peersRef.current = peersRef.current.filter((p) => p.peerID !== userToCall);
      setPeers([...peersRef.current]);
    });

      console.log(`Peer connection FULLY established with ${from}`, {
        duration: Date.now() - connectionLog.created,
        connectionLog
      });
    });

    peer.on('stream', (receivedStream) => {
      connectionLog.streamReceived = true;
      console.log(`Stream received from ${from}`, {
        streamTracks: receivedStream.getTracks().map(t => t.kind)
      });
      setRemoteStreams((prev) => ({
        ...prev, 
        [from]: receivedStream
      }));
    });

    peer.on('close', () => {
      connectionLog.closed = true;
      console.warn(`Peer connection CLOSED with ${from}`, {
        duration: Date.now() - connectionLog.created,
        connectionLog
      });
      
      peersRef.current = peersRef.current.filter((p) => p.peerID !== from);
      setPeers([...peersRef.current]);
      
      setRemoteStreams((prev) => {
        const newStreams = { ...prev };
        delete newStreams[from];
        return newStreams;
      });
    });

    peer.on('error', (err) => {
      connectionLog.error = err.toString();
      console.error(`Comprehensive Peer ERROR with ${from}:`, {
        error: err,
        connectionLog
      });

      try {
        peer.destroy();
      } catch (destroyErr) {
        console.error('Error during peer destruction:', destroyErr);
      }

      peersRef.current = peersRef.current.filter((p) => p.peerID !== from);
      setPeers([...peersRef.current]);
    });

    // Safely signal the peer
    try {
      peer.signal(incomingSignal);
    } catch (signalErr) {
      console.error('Error signaling peer:', signalErr);
      peer.destroy();
    }

    return peer;
  }

  return (
    <div style={{ textAlign: 'center', marginTop: 40 }}>
      <h2>Room: {roomId}</h2>
      {!role && (
        <div style={{ margin: '30px 0' }}>
          <button onClick={() => handleRoleSelect('broadcaster')} style={{ marginRight: 16, padding: '12px 24px', fontSize: 16 }}>Start as Broadcaster</button>
          <button onClick={() => handleRoleSelect('viewer')} style={{ padding: '12px 24px', fontSize: 16 }}>Join as Viewer</button>
        </div>
      )}
      {role && <h3>Role: {role}</h3>}
      {role === 'broadcaster' && (
        <video ref={userVideoRef} autoPlay muted playsInline style={{ width: 400 }} />
      )}
      {role === 'viewer' &&
        Object.values(remoteStreams).map((stream, idx) => (
          <video
            key={idx}
            autoPlay
            playsInline
            style={{ width: 400 }}
            ref={el => {
              if (el && stream) {
                el.srcObject = stream;
              }
            }}
          />
        ))}
      {role === 'viewer' && Object.keys(remoteStreams).length === 0 && (
        <div>No stream received yet. Waiting for broadcaster...</div>
      )}
    </div>
  );
};

export default Room;
