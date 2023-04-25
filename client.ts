import assert from 'node:assert'
import { inspect } from 'node:util'
import path from 'node:path'
import socketioClient from 'socket.io-client'
import fs from 'fs-extra'
import lodash from 'lodash'

const IPCTIMEOUT = 15000 as const // 15 sec
const IPCDIR = getIpcDir()
const IPCPATH = path.join(IPCDIR, 'ipc.json')
const IPCLOCKF = path.join(IPCDIR, 'LOCK')
const IPCUNLOCKF = path.join(IPCDIR, 'UNLOCK')
const IPCLOGF = path.join(IPCDIR, 'log-latest.txt')
const CLIENTUPF = path.join(IPCDIR, 'CLIENTUP')
const SERVERURL = 'https://chatnet-server.midnqp.repl.co'
const io = socketioClient(SERVERURL)
main()

async function main() {
    assert(IPCDIR != '', 'database not found')
    logDebug('hi')
    setClientAvailable()

    logDebug("listening for 'broadcast'")
    io.on('broadcast', addToRecvQueue)

    logDebug('send-msg-loop starting')
    while (await toLoop()) {
        await emitFromSendQueue()
        await sleep(500)
    }

    logDebug('closing socket.io')
    io.close()
    setClientUnavailable()
    logDebug('bye')
}

async function addToRecvQueue(msg: SioMessage) {
    const bucket = await ipcExec(() => ipcGet('recvmsgbucket'))
    const arr = bucket
    //const arr: IpcMsgBucket = JSON.parse(bucket)
    if (!Array.isArray(arr)) return

    arr.push(msg)
    await ipcExec(() => ipcPut('recvmsgbucket', arr))
}

async function emitFromSendQueue() {
    const bucket = await ipcExec(() => ipcGet('sendmsgbucket'))
    //let arr: IpcMsgBucket = JSON.parse(bucket)
    const arr = bucket

    if (!arr.length) return

    const arrNew = new Array(...arr)
    logDebug('found sendmsgbucket', arr)
    for (let item of arrNew) {
        logDebug('sending message', item)
        await io.emitWithAck('message', item).then(() => lodash.remove(arrNew, item))
    }
    await ipcExec(() => ipcPut('sendmsgbucket', arrNew))
}

// code below are mostly utils

async function ipcGet(key: string) {
    const tryFn = async () => {
        const str = await fs.readFile(IPCPATH, 'utf8')
        logDebug(`ipcGet:  key:`, key, `  ipc.json:`, str)
        const json: Record<string, any> = JSON.parse(str)
        let value = json[key]
        if (value === undefined) value = null
        return value
    }
    const catchFn = e => logDebug('ipcGet: something failed: retry', e)

    return retryableRun(tryFn, catchFn)
}

async function ipcPut(
    key: string,
    val: Record<string, any> | Array<any> | string | number
) {
    const tryFn = async () => {
        const str = await fs.readFile(IPCPATH, 'utf8')
        logDebug(`ipcPut:  `, key, `  ipc.json:`, str)
        const json: Record<string, any> = JSON.parse(str)
        json[key] = val
        await fs.writeJson(IPCPATH, json)
    }
    const catchFn = e => logDebug('ipcPut: something failed: retry', e)

    return retryableRun(tryFn, catchFn)
}

/** runtime debug logs */
function logDebug(...any) {
    if (!process.env.CHATNET_DEBUG) return

    let result = ''
    for (let each of any) result += inspect(each) + ' '
    if (any.length) result.slice(0, result.length - 1)

    const d = new Date().toISOString()
    const str = '[sio-client]  ' + d + '  ' + result + '\n'
    fs.appendFileSync(IPCLOGF, str)
}

/** checks if event loop should continue running */
async function toLoop() {
    let result = true
	const userstate = await ipcExec(() => ipcGet('userstate'))
	if (userstate === false) result = false
    return result
}

/** promise-based sleep */
function sleep(ms: number) {
    return new Promise(r => setTimeout(r, ms))
}

/** returns folder for IPC based on platform */
function getIpcDir() {
    let p = ''
    if (process.platform == 'linux') {
        const HOME = process.env.HOME
        assert(HOME !== undefined)
        p = path.join(HOME, '.config', 'chatnet-client')
    }
    return p
}

async function setIpcLock() {
    return retryableRun(() => fs.rename(IPCUNLOCKF, IPCLOCKF))
}

async function unsetIpcLock() {
    return retryableRun(() => fs.rename(IPCLOCKF, IPCUNLOCKF))
}

function setClientAvailable() {
    fs.ensureFileSync(CLIENTUPF)
}

function setClientUnavailable() {
    fs.existsSync(CLIENTUPF) && fs.unlinkSync(CLIENTUPF)
}

async function ipcExec(fn: () => Promise<any>) {
    const tryFn = async () => {
        const existsLock = await fs.exists(IPCLOCKF)
        const existsUnlock = await fs.exists(IPCUNLOCKF)
        if (!existsLock && existsUnlock) {
            await setIpcLock()
            const result = await fn()
            await unsetIpcLock()
            return result
        } else throw Error('database not reachable')
    }
    const catchFn = () => logDebug(`database is locked, retrying`)

    return retryableRun(tryFn, catchFn)
}

/**
 * runs a function, keeps retyring
 * every 50ms on failure, throws
 * error in case of timeout
 */
async function retryableRun(tryFn, catchFn: Function = () => {}) {
    let n = 0
    const maxN = IPCTIMEOUT
    while (true) {
        try {
            return await tryFn()
        } catch (err: any) {
            await catchFn(err)
            if (n > maxN) throw Error(err.message)
            n += 50
            await sleep(50)
        }
    }
}

type IpcMsgBucket = Array<SioMessage>
type SioMessage = { type: 'message'; username: string; data: string }
type SioMeta = { type: 'file'; name: string; data: string }
