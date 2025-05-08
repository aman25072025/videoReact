import React, { useEffect, useRef, useState } from 'react';
import Peer from 'simple-peer';
import socket from './socket';

const Room = ({ roomId }) => {
  const [role, setRole] = useState(null);
  const [peers, setPeers] = useState([]); // Array of { peerID, peer }
  const [remoteStreams, setRemoteStreams] = useState({}); // peerID: stream
  const [joined, setJoined] = useState(false);
  const userVideoRef = useRef();
  const userStream = useRef();
  const peersRef = useRef([]);
  const [broadcasterId, setBroadcasterId] = useState(null);

  const handleRoleSelect = (selectedRole) => {
    setRole(selectedRole);
    const userName = 'user' + Date.now();
    socket.emit('BE-join-room', { roomId, userName, role: selectedRole });
    setJoined(true);
    if (selectedRole === 'broadcaster') {
      navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then((stream) => {
        userStream.current = stream;
        if (userVideoRef.current) userVideoRef.current.srcObject = stream;
      });
    }
  };

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
          { urls: 'stun:stun.l.google.com:19302' },
          {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject',
          },
        ],
      },
    });

    peer.on('signal', (signal) => {
      socket.emit('BE-call-user', { userToCall, from, signal });
    });

    peer.on('error', console.error);
    peer.on('close', () => removePeer(userToCall));
    return peer;
  };

  const addPeer = (incomingSignal, from) => {
    const peer = new Peer({
      initiator: false,
      trickle: false,
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
        Object.entries(remoteStreams).map(([id, stream]) => (
          <video
            key={id}
            autoPlay
            playsInline
            ref={el => {
              if (el && stream) el.srcObject = stream;
            }}
            style={{ width: 400, margin: '10px auto' }}
          />
        ))}
      {role === 'viewer' && Object.keys(remoteStreams).length === 0 && (
        <div>No stream received yet. Waiting for broadcaster...</div>
      )}
    </div>
  );
};

export default Room;
