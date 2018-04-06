/* @flow */

import uuidv4 from 'uuid/v4';

import type { AnyProcess, Handler, Cancelable } from '../types';
import { MESSAGE_TYPE, MESSAGE_STATUS, BUILTIN_MESSAGE, ENV_FLAG } from '../conf';

import { serializeMethods, deserializeMethods } from './serialization';

export function isWorker() : boolean {
    return Boolean(process.env[ENV_FLAG.PROCESS_ROBOT_WORKER]);
}

let requestListeners = new Map();
let responseListeners = {};

function cancelListener(process : AnyProcess, name : string) {
    let nameRequestListeners = requestListeners.get(process);

    if (nameRequestListeners) {
        delete nameRequestListeners[name];
    }
}

export function listen<M : mixed, R : mixed>(proc : AnyProcess, name : string, handler : Handler<M, R>) : Cancelable {
    let nameRequestListeners = requestListeners.get(proc);

    if (!nameRequestListeners) {
        nameRequestListeners = {};
        requestListeners.set(proc, nameRequestListeners);
    }

    if (nameRequestListeners[name]) {
        throw new Error(`Listener already registered for process with name: "${ name }"`);
    }

    nameRequestListeners[name] = handler;

    return {
        cancel: () => cancelListener(proc, name)
    };
}

export type ListenFunctionType = typeof listen;

export async function send<M : mixed, R : mixed>(proc : AnyProcess | Process, name : string, message : M) : Promise<R> {

    if (!proc) {
        throw new Error(`Expected process to send message to`);
    }

    let uid = uuidv4();

    message = serializeMethods(proc, message, listen);

    return await new Promise((resolve, reject) => {
        responseListeners[uid] = { resolve, reject };

        // $FlowFixMe
        proc.send({ type: MESSAGE_TYPE.REQUEST, uid, name, message });
    });
}

export type SendFunctionType = typeof send;

export function setupListener(proc : AnyProcess) {
    proc.on('message', async (msg) => {
        if (!msg || !msg.type) {
            return;
        }

        let { uid, name, type } = msg;

        if (type === MESSAGE_TYPE.REQUEST) {

            const nameListeners = requestListeners.get(proc);
            const handler = nameListeners && nameListeners[name];

            let { message } = msg;
            let response;

            try {
                if (!handler) {
                    throw new Error(`No handler found for message: ${ name } in ${ isWorker() ? 'worker' : 'master' } process ${ process.pid }\n\n${ JSON.stringify(msg, null, 4) }`);
                }

                response = await handler(deserializeMethods(proc, message, send));

                // $FlowFixMe
                proc.send({ type: MESSAGE_TYPE.RESPONSE, status: MESSAGE_STATUS.SUCCESS, uid, name, response: serializeMethods(proc, response, listen) });
                
            } catch (err) {

                // $FlowFixMe
                proc.send({ type: MESSAGE_TYPE.RESPONSE, status: MESSAGE_STATUS.ERROR, uid, name, error: err.stack || err.message });
            }

        } else if (type === MESSAGE_TYPE.RESPONSE) {

            let responseHandler = responseListeners[uid];

            if (!responseHandler) {
                throw new Error(`No response handler found for message: ${ name }, ${ uid }`);
            }

            let { resolve, reject } = responseHandler;

            let { status, response, error } = msg;

            if (status === MESSAGE_STATUS.SUCCESS) {
                resolve(deserializeMethods(proc, response, send));
            } else if (status === MESSAGE_STATUS.ERROR) {
                reject(new Error(error));
            }
        }
    });

    listen(proc, BUILTIN_MESSAGE.REQUIRE, name => {
        // $FlowFixMe
        return require(name); // eslint-disable-line security/detect-non-literal-require
    });
}

export function destroyListeners(proc : AnyProcess) {
    if (requestListeners.has(proc)) {
        requestListeners.delete(proc);
    }
}
