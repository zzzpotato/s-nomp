import { EventEmitter } from 'events';
import net from 'net';

export default class CliListener extends EventEmitter {
    constructor(port, host = '127.0.0.1') {
        super();
        this.port = port;
        this.host = host;
        this.init();
    }

    init() {
        const server = net.createServer(connection => {
            this.emit('log', `CLI connection from ${connection.remoteAddress}`);
            
            connection.on('data', data => {
                this.handleMessage(data, connection);
            });

            connection.on('end', () => {
                this.emit('log', 'CLI connection ended');
            });

            connection.on('error', () => {
                this.emit('log', 'CLI connection error');
            });
        });

        server.listen(this.port, this.host, () => {
            this.emit('log', `CLI listening on ${this.host}:${this.port}`);
        });
    }

    handleMessage(message, connection) {
        try {
            const commandData = message.toString().trim();
            if (!commandData) return;

            const [command, ...parts] = commandData.split(' ');
            const params = [];
            const options = {};

            // Parse parameters and options
            parts.forEach(part => {
                if (part.startsWith('--')) {
                    const [key, value] = part.substring(2).split('=');
                    options[key] = value || true;
                } else {
                    params.push(part);
                }
            });

            const reply = (message) => {
                connection.write(message + '\n');
            };

            this.emit('command', command, params, options, reply);
        } catch (err) {
            connection.write(`Error parsing command: ${err.message}\n`);
        }
    }
}
