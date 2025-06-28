import React, { useEffect, useRef, useState } from 'react';
import Peer from 'simple-peer';
import socket from './socket';

const Room = ({ roomId }) => {
    const [role, setRole] = useState(null);
    const [peers, setPeers] = useState([]);
    const [remoteStreams, setRemoteStreams] = useState({});
    const [joined, setJoined] = useState(false);
    const [isAudioMuted, setIsAudioMuted] = useState(false);
    const [isVideoOff, setIsVideoOff] = useState(false);
    const [handRaised, setHandRaised] = useState(false);
    const userVideoRef = useRef();
    const userStream = useRef();
    const peersRef = useRef([]);
    const [broadcasterId, setBroadcasterId] = useState(null);
    const [raisedHands, setRaisedHands] = useState([]);
    const [isApproved, setIsApproved] = useState(false);
    const [approvedSpeakers, setApprovedSpeakers] = useState([]);

    const handleRoleSelect = (selectedRole) => {
        setRole(selectedRole);
        const userName = 'User-' + Date.now();
        socket.emit('BE-join-room', { roomId, userName, role: selectedRole });
        setJoined(true);

        navigator.mediaDevices.getUserMedia({ video: true, audio: true })
            .then((stream) => {
                // 👇 Disable mic and camera *before* assigning to video element
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

    useEffect(() => {
        const handleAssignRole = ({ role, broadcasterId }) => {
            setRole(role);
            setBroadcasterId(broadcasterId);
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
        const handleViewerStopped = ({ userId }) => {
            setApprovedSpeakers(prev => prev.filter(id => id !== userId));
        };
        socket.on('FE-viewer-stopped', handleViewerStopped); // broadcaster removes from approved list
        socket.on('FE-user-join', handleUserJoin);
        return () => {
            socket.off('FE-viewer-stopped', handleViewerStopped);
            socket.off('FE-user-join', handleUserJoin);
        };
    }, [role]);

    useEffect(() => {
        if (!role) return;

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

        const handleCallAccepted = ({ signal, answerId }) => {
            const item = peersRef.current.find(p => p.peerID === answerId);
            if (item) item.peer.signal(signal);
        };

        const handleRaisedHand = ({ userId, userName }) => {
            setRaisedHands(prev => prev.some(p => p.userId === userId) ? prev : [...prev, { userId, userName }]);
        };

        const handleSpeakerApproved = () => {
            setIsApproved(true);

            if (userStream.current) {
                userStream.current.getAudioTracks().forEach(track => (track.enabled = true));
                userStream.current.getVideoTracks().forEach(track => (track.enabled = true));
                setIsAudioMuted(false);
                setIsVideoOff(false);
            }
        };

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

        const handleSpeakerDeclined = () => {
            // Reset the viewer to pre-request state
            setIsApproved(false);
            setIsAudioMuted(true);
            setIsVideoOff(true);
            setHandRaised(false);

            if (userStream.current) {
                userStream.current.getAudioTracks().forEach(track => (track.enabled = false));
                userStream.current.getVideoTracks().forEach(track => (track.enabled = false));
            }
        };

        const handleDecline = () => {
            setHandRaised(false);
        };

        socket.on('FE-speaker-declined', handleSpeakerDeclined);
        socket.on('FE-viewer-stop-speaking', handleStopSpeaking); // viewer disables their stream
        socket.on('FE-receive-call', handleReceiveCall);
        socket.on('FE-call-accepted', handleCallAccepted);
        socket.on('FE-raised-hand', handleRaisedHand);
        socket.on('FE-speaker-approved', handleSpeakerApproved);
        socket.on('FE-decline-speaker', handleDecline);

        return () => {
            socket.off('FE-receive-call', handleReceiveCall);
            socket.off('FE-call-accepted', handleCallAccepted);
            socket.off('FE-raised-hand', handleRaisedHand);
            socket.off('FE-speaker-approved', handleSpeakerApproved);
            socket.off('FE-viewer-stop-speaking', handleStopSpeaking);
            socket.off('FE-speaker-declined', handleSpeakerDeclined);
            socket.off('FE-decline-speaker', handleDecline);
        };
    }, [role]);

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

    const removePeer = (peerID) => {
        peersRef.current = peersRef.current.filter(p => p.peerID !== peerID);
        setPeers([...peersRef.current]);
        setRemoteStreams(prev => {
            const updated = { ...prev };
            delete updated[peerID];
            return updated;
        });
    };

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

    const stopSpeaking = () => {
        if (userStream.current) {
            userStream.current.getAudioTracks().forEach(track => (track.enabled = false));
            userStream.current.getVideoTracks().forEach(track => (track.enabled = false));
        }
        setIsApproved(false);
        setIsAudioMuted(true);
        setIsVideoOff(true);
        setHandRaised(false); // ✅ Enable "Request to Speak" again
        socket.emit('BE-stop-speaking', { roomId, userId: socket.id });
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
                <div>
                    <video ref={userVideoRef} autoPlay muted playsInline style={{ width: '100%', maxWidth: 800, borderRadius: 8, background: '#000' }} />


                    {approvedSpeakers.length > 0 && (
  <div style={{ marginTop: 20 }}>
    <h4>Currently Speaking</h4>
    {approvedSpeakers.map(userId => (
      <div key={userId} style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'center' }}>
        <span>{userId}</span>
        <button onClick={() => {
          socket.emit('BE-stop-speaking', { roomId, userId });
          setApprovedSpeakers(prev => prev.filter(id => id !== userId));
        }}>
          🛑 Stop Speaking
        </button>
      </div>
    ))}
  </div>
)}



                    {/* ✅ Viewer stream thumbnails */}
                    <div
                        style={{
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: 10,
                            justifyContent: 'center',
                            marginTop: 20
                        }}
                    >
                        {Object.entries(remoteStreams).map(([userId, stream]) => {
                            const raisedUser = raisedHands.find(p => p.userId === userId);
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
  <div style={{
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
    borderRadius: 8
  }}>
    {isPendingApproval && (
      <>
        <div style={{ fontSize: 32 }}>✋</div>
        <div style={{ marginTop: 8, display: 'flex', gap: 10 }}>
          <button
            title="Approve"
            onClick={() => {
              setApprovedSpeakers(prev => [...prev, userId]);
              socket.emit('BE-approve-speaker', { roomId, userId });
              setRaisedHands(prev => prev.filter(p => p.userId !== userId));
            }}
            style={{
              fontSize: 16,
              padding: '6px 12px',
              borderRadius: 6,
              border: 'none',
              background: '#4CAF50',
              color: '#fff',
              cursor: 'pointer'
            }}
          >
            ✅ Approve
          </button>
          <button
            title="Decline"
            onClick={() => {
              socket.emit('BE-decline-speaker', { roomId, userId });
              setRaisedHands(prev => prev.filter(p => p.userId !== userId));
            }}
            style={{
              fontSize: 16,
              padding: '6px 12px',
              borderRadius: 6,
              border: 'none',
              background: '#f44336',
              color: '#fff',
              cursor: 'pointer'
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
          setApprovedSpeakers(prev => prev.filter(id => id !== userId));
        }}
        style={{
          marginTop: 8,
          fontSize: 16,
          padding: '6px 12px',
          borderRadius: 6,
          border: 'none',
          background: '#f44336',
          color: '#fff',
          cursor: 'pointer'
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
            )}

            {role === 'viewer' && (
                <div style={{ position: 'relative', maxWidth: 800, margin: '0 auto' }}>
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
