class Session {
    constructor (socket) {
        this._socket = socket;
        this._nextId = 0;
        this._type = '';
        this._completionHandlers = {};
        this.onMessage = this.onMessage.bind(this);
        this.dispose = this.dispose.bind(this);
        this._socket.addListener('message', this.onMessage);
    }

    dispose () {
        if (this._socket) {
            console.log('dispose socket');
            this._socket.removeListener('message', this.onMessage);
            if (this._socket.readyState === this._socket.OPEN) {
                this._socket.close();
            }
        }
        this._socket = null;
        this._completionHandlers = null;
    }

    getNextId () {
        // Start from 1: an id of 0 is falsy and gets dropped by the
        // truthiness checks in the JSON-RPC transports on both sides
        // (see didReceiveResponse below and openblock-vm util/jsonrpc.js),
        // which used to break the first server-initiated request that
        // expected an answer (e.g. uploadFirmwareConfirm).
        return ++this._nextId;
    }

    makeResponse (id, result, error) {
        const response = {
            id,
            jsonrpc: '2.0'
        };
        if (error) {
            response.error = error;
        } else {
            response.result = result;
        }
        return response;
    }

    onMessage (message) {
        this.didReceiveMessage(message, response => {
            if (this._socket) {
                this._socket.send(response);
            }
        });
    }

    onBinary () {

    }

    didReceiveMessage (message, sendResponseText) {
        const json = JSON.parse(message);
        const sendResponseInternal = (result, error) => {
            const response = this.makeResponse(json.id, result, error);
            sendResponseText(JSON.stringify(response));
        };
        const sendResponse = (result, error) => {
            try {
                sendResponseInternal(result, error);
            } catch (err1) {
                sendResponseInternal(null, 'Could not encode response');
            }
        };
        try {
            if (json.jsonrpc !== '2.0') {
                throw new Error('unrecognized JSON-RPC version string');
            }
            if (json.method) {
                this.didReceiveRequest(json, (result, err) => sendResponse(result, err));
            } else if (Object.prototype.hasOwnProperty.call(json, 'result') ||
                Object.prototype.hasOwnProperty.call(json, 'error')) {
                // Presence check instead of truthiness: a response whose
                // result is null/false/0 is still a valid response.
                this.didReceiveResponse(json);
            } else {
                throw new Error('message is neither request nor response');
            }
        } catch (err) {
            sendResponse(null, err);
        }
    }

    didReceiveRequest (request, sendResult) {
        const {method, params} = request;
        if (typeof method !== 'string') {
            throw new Error('methon value missing or not a string');
        }
        this.didReceiveCall(method, params || {}, sendResult);
    }

    didReceiveResponse (response) {
        const {id, error, result} = response;
        if (id === null || typeof id === 'undefined') {
            throw new Error('response ID value missing or wrong type');
        }
        const completionHandler = this._completionHandlers[id];
        if (!completionHandler) {
            throw new Error('response ID does not correspond to any open request');
        }
        try {
            if (error) {
                completionHandler(null, error);
            } else {
                completionHandler(result, null);
            }
        } catch (err) {
            throw new Error(`exception encountered while handling response ${id}`);
        }
    }

    didReceiveCall () {
    }

    sendRemoteRequest (method, params, completion) {
        const request = {
            jsonrpc: '2.0',
            method
        };
        if (typeof params !== 'undefined') {
            request.params = params;
        }
        if (completion) {
            const requestId = this.getNextId();
            request.id = requestId;
            this._completionHandlers[requestId] = completion;
        }
        try {
            if (this._socket) {
                this._socket.send(JSON.stringify(request));
            }
        } catch (err) {
            console.log(`Error serializing or sending request: ${err}`);
            console.log(`Request was: ${request}`);
        }
    }
}

module.exports = Session;
