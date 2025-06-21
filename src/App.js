import React, { useState } from 'react';
import Room from './Room';

function App() {
  console.log('App rendered');
  const [roomId, setRoomId] = useState('');
  const [joined, setJoined] = useState(false);
  const [input, setInput] = useState('');

  const handleJoin = (e) => {
    e.preventDefault();
    console.log('Join form submitted with input:', input);
    if (input.trim()) {
      setRoomId(input.trim());
      setJoined(true);
    }
  };

  if (!joined) {
    return (
      <div style={{ textAlign: 'center', marginTop: 80 }}>
        <h2>Enter Room No28</h2>
        <form onSubmit={handleJoin}>
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Room name"
            style={{ padding: 10, fontSize: 16 }}
            autoFocus
          />
          <button type="submit" style={{ marginLeft: 12, padding: '10px 20px', fontSize: 16 }}>Join</button>
        </form>
      </div>
    );
  }

  console.log('Rendering Room with roomId:', roomId);
  return <Room roomId={roomId} />;
}

export default App;
