const express = require('express');
const socketIo = require('socket.io');
const http = require('http');
const { MongoClient } = require("mongodb");
const bodyParser = require('body-parser');
const cors = require('cors');
require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const cookieParser = require('cookie-parser');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    maxHttpBufferSize: 40e6 // 40 MB limit for HTTP buffer size
});
const port = 3007;
const socketsdb = new Map();
const routes = new Map();
const responses = new Map();
const client_ports = new Map();

app.use(cors("*"));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.raw({ type: '*/*', limit: '40mb' }));
app.use(cookieParser());

const verifyApi = async (api_key) => {
    const mongoClient = new MongoClient(process.env.DB_URI);
    const db = mongoClient.db('authentication');
    const collection = db.collection('user_credentials');
    await mongoClient.connect();
    const info = await collection.find({ "api_key": api_key }).toArray();
    if (info.length === 0) {
        return null;
    }
    return info[0];
};

const processPath = (path) => {
    const t = path.split("/");
    const t1 = (t[2]).split("_");
    const port = t1[t1.length - 1];
    t1[t1.length - 1] = "";
    const t2 = t.slice(3, t.length);
    return [(t1.join("_")).slice(0, -1), port, `/${t2.join("/")}`];
};

app.post('/verifyApi', async (req, res) => {
    const data = JSON.parse((req.body).toString());
    const result = await verifyApi(data["api_key"]);
    if (!result) {
        res.status(400).send();
    } else {
        res.send(result);
    }
});

app.all('/tunnel/*', (req, res) => {
    const requestId = uuidv4();
    const requestData = {
        method: req.method,
        headers: req.headers,
        body: req.body.toString('base64'),
        path: req["path"],
        query: req.query,
        requestId,
    };
    const data = processPath(requestData.path);
    const api_key = data[0];
    const port = data[1];
    const ports = client_ports.get(api_key);
    
    if (ports.length == 0) {
        res.status(404).send()
        return
    }
    let flag = false;
    ports.forEach((e) => {
        if (e == port) {
            flag = true;
        }
    });
    if (!flag) {
        res.status(404).send();
        return;
    }
    requestData["port"] = port;
    const socketid = routes.get(api_key);
    const socket = socketsdb.get(socketid);
    requestData["path"] = data[2];
    res.cookie('TunnelExpress_api_key', api_key);
    res.cookie('TunnelExpress_client_port', port);
    responses.set(requestId, res);
    socket.emit("request", requestData);
});

app.all('*', (req, res) => {
    const requestId = uuidv4();
    const requestData = {
        method: req.method,
        headers: req.headers,
        body: req.body.toString('base64'), // Encode body as base64 string
        path: req["path"],
        query: req.query,
        requestId,
    };
    const cookies = req.cookies;
    const TunnelExpress_api_key = cookies["TunnelExpress_api_key"];
    const TunnelExpress_client_port = cookies["TunnelExpress_client_port"];
    if (TunnelExpress_api_key && TunnelExpress_client_port) {
        const api_key = TunnelExpress_api_key;
        const port = TunnelExpress_client_port;
        const ports = client_ports.get(api_key);
        if (ports.length == 0) {
            res.status(404).send()
            return
        }
        let flag = false;
        ports.forEach((e) => {
            if (e == port) {
                flag = true;
            }
        });
        if (!flag) {
            res.status(404).send();
            return;
        }
        requestData["port"] = port;
        const socketid = routes.get(api_key);
        const socket = socketsdb.get(socketid);
        res.cookie('TunnelExpress_api_key', api_key);
        res.cookie('TunnelExpress_client_port', port);
        responses.set(requestId, res);
        socket.emit("request", requestData);
    } else {
        res.sendStatus(404);
    }
});

app.get('/', (req, res) => {
    res.send('Welcome to TunnelExpress');
});

io.on('connection', (socket) => {
    console.log('TunnelXpress.exe client connected', socket.id);
    socketsdb.set(socket.id, socket);
    socket.on("register_ports", async (data) => {
        const result = await verifyApi(data["api_key"]);
        if (!result) {
            socket.emit("port_register_ack", { "message": "something went wrong", "ack": false });
        } else {
            routes.set(data["api_key"], socket.id);
            client_ports.set(data["api_key"], data["ports"]);
            socket.emit("port_register_ack", { "ack": true, "ports": data["ports"], "api_key": data["api_key"] });
        }
    });

    socket.on('response', async (response) => {
        const res = responses.get(response["requestId"]);
        if (res) {
            res.status(response.status);
            const headers = response.headers;
            if (headers['Content-Encoding']) {
                delete headers['Content-Encoding'];
            }
            res.set(headers);
            if (response.body) {
                const bodyBuffer = Buffer.from(response.body, 'base64');
                res.send(bodyBuffer);
            } else {
                res.end();
            }
            responses.delete(response["requestId"]);
        }
    });

    socket.on('disconnect', () => {
        socketsdb.delete(socket.id);
        console.log(`disconnected ${socket.id}`);
    });
});

server.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
