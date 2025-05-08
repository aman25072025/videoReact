import io from 'socket.io-client';

// Use deployed server for production, localhost for dev
// const SERVER_URL ='https://testvideonode.onrender.com'
const SERVER_URL = 'https://videonode.onrender.com';

const socket = io(SERVER_URL);

export default socket;
