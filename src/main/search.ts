import _ from 'lodash'

import * as cp from 'child_process'
import * as path from 'path'
import { ipcMain, IpcMainInvokeEvent } from 'electron'
import { promisify } from 'util'
import { app } from 'electron'
import Fuse from 'fuse.js'

import { platformResourcesDir, PLATFORM_INFO, rgLoc } from './utils'

// Use fuse.js for fuzzy search of files
let cachedFuseInstance: Fuse<string> | null = null
let cachedFuseRootPath: string = ''
const FUSE_OPTIONS = {
    includeScore: true,
    threshold: 0.3,
    distance: 50,
}

const searchRipGrep = async (
    event: IpcMainInvokeEvent,
    arg: {
        query: string
        rootPath: string
        badPaths: string[]
        caseSensitive: boolean
    }
) => {
    // Instead run ripgrep fromt the cli
    // let cmd = ['rg', '--json', '--line-number', '--with-filename']
    let cmd = ['--json', '--line-number', '--with-filename', '--sort-files']
    if (arg.caseSensitive) {
        cmd.push('--case-sensitive')
    } else {
        cmd.push('-i')
    }

    for (let badPath of arg.badPaths) {
        cmd.push('--ignore-file', badPath)
    }

    // cmd.push(`"${arg.query}"`, arg.rootPath);
    cmd.push(arg.query, arg.rootPath)
    let start = performance.now()
    let childProcess = cp.spawn(rgLoc, cmd)

    let rawData: string[] = []
    let errored = false
    var overflowBuffer = ''

    const trimLines = (lines: string) => {
        lines = overflowBuffer + lines
        overflowBuffer = ''

        return lines
            .trim()
            .split('\n')
            .filter((match) => {
                try {
                    let data = JSON.parse(match)
                    if (data.type === 'match') {
                        return match
                    }
                } catch (e: any) {
                    overflowBuffer += match
                }
            })
    }

    childProcess.on('error', (err) => {
        errored = true
    })

    childProcess.stdout.on('data', (chunk) => {
        rawData.push(...trimLines(chunk.toString()))
        if (rawData.length > 500) {
            // Exit the process
            childProcess.kill()
        }
    })

    // Wait for the process to finish
    await new Promise((resolve, reject) => {
        childProcess.on('close', (code) => {
            resolve(code)
        })
    })

    return rawData
}

const customDebounce = (func: any, wait: number = 0) => {
    let timeout: any
    let lastCall = 0

    return (...args: any[]) => {
        const now = Date.now()
        if (now - lastCall < wait) {
            clearTimeout(timeout)
            return new Promise((resolve, reject) => {
                timeout = setTimeout(() => {
                    lastCall = now
                    let out = func(...args)
                    return resolve(out)
                }, wait)
            })
        } else {
            lastCall = now
            return func(...args)
        }
    }
}

const searchFilesName = async (
    event: IpcMainInvokeEvent,
    {
        query,
        rootPath,
        topResults = 50,
    }: {
        query: string
        rootPath: string
        topResults?: number
    }
) => {
    const queryKeywords = query
        .split(' ')
        .map((k) => `*${k}*`)
        .join('')
    const cmd =
        process.platform === 'win32'
            ? `${rgLoc} --iglob "${queryKeywords}" --files '' ./ | head -n ${topResults}`
            : `find . -type f -iname "${queryKeywords}" | head -n ${topResults}`
    const { stdout } = await promisify(cp.exec)(cmd, { cwd: rootPath })
    return stdout
        .split('\n')
        .map((s: string) => {
            if (s.startsWith('./')) {
                return s.slice(2)
            }
            return s
        })
        .filter(Boolean)
}

const searchFilesPath = async (
    event: IpcMainInvokeEvent,
    {
        query,
        rootPath,
        topResults = 50,
    }: {
        query: string
        rootPath: string
        topResults?: number
    }
) => {
    const wildcardQuery = query.split('').join('*')
    const cmd =
        process.platform === 'win32'
            ? `${rgLoc} --iglob "*${query}*" --files '' ./ | head -n ${topResults}`
            : `find . -typef -ipath "*${query}*" | head -n ${topResults}`
    const { stdout } = await promisify(cp.exec)(cmd, { cwd: rootPath })
    return stdout
        .split('\n')
        .map((s: string) => {
            if (s.startsWith('./')) {
                return s.slice(2)
            }
            return s
        })
        .filter(Boolean)
}

const searchFilesPathGit = async (
    event: IpcMainInvokeEvent,
    {
        query,
        rootPath,
        topResults = 50,
    }: {
        query: string
        rootPath: string
        topResults?: number
    }
) => {
    if (await doesCommandSucceed('git ls-files ffff', rootPath)) {
        if (cachedFuseRootPath !== rootPath) {
            const cmd = `git ls-files`
            try {
                const { stdout } = await promisify(cp.exec)(cmd, {
                    cwd: rootPath,
                })
                const files = stdout.split('\n').filter(Boolean)
                cachedFuseInstance = new Fuse(files, FUSE_OPTIONS)
                cachedFuseRootPath = rootPath
            } catch (e) {
                cachedFuseInstance = null
                cachedFuseRootPath = ''
            }
        }

        if (cachedFuseInstance) {
            const results = cachedFuseInstance
                .search(query)
                .slice(0, topResults)
            return results.map((result) => {
                // map / to connector.PLATFORM_DELIMITER
                return result.item.replace(
                    /\//g,
                    PLATFORM_INFO.PLATFORM_DELIMITER
                )
            })
        }
    }
    return await searchFilesPath(event, { query, rootPath, topResults })
}

const doesCommandSucceed = async (cmd: string, rootPath: string) => {
    try {
        const res = await promisify(cp.exec)(cmd, { cwd: rootPath })
        return true
    } catch (e) {
        return false
    }
}

const searchFilesNameGit = async (
    event: IpcMainInvokeEvent,
    {
        query,
        rootPath,
        topResults = 50,
    }: {
        query: string
        rootPath: string
        topResults?: number
    }
) => {
    if (await doesCommandSucceed('git ls-files ffff', rootPath)) {
        if (cachedFuseRootPath !== rootPath) {
            const cmd = `git ls-files`
            try {
                const { stdout } = await promisify(cp.exec)(cmd, {
                    cwd: rootPath,
                })
                const files = stdout.split('\n').filter(Boolean)
                cachedFuseInstance = new Fuse(files, FUSE_OPTIONS)
                cachedFuseRootPath = rootPath
            } catch (e) {
                cachedFuseInstance = null
                cachedFuseRootPath = ''
            }
        }

        if (cachedFuseInstance) {
            const results = cachedFuseInstance
                .search(query)
                .slice(0, topResults)
            return results
                .map((result) => {
                    const file = result.item
                    const fileName = file.substring(file.lastIndexOf('/') + 1)
                    return { file, fileName }
                })
                .filter(({ fileName }) =>
                    fileName.toLowerCase().includes(query.toLowerCase())
                )
                .map(({ file }) =>
                    file.replace(/\//g, PLATFORM_INFO.PLATFORM_DELIMITER)
                )
        }
    }
    // we'll have to run it with find
    return await searchFilesName(event, { query, rootPath, topResults })
}

export const setupSearch = () => {
    ipcMain.handle('searchRipGrep', customDebounce(searchRipGrep))
    ipcMain.handle('searchFilesName', customDebounce(searchFilesName))
    ipcMain.handle('searchFilesPath', customDebounce(searchFilesPath))
    ipcMain.handle('searchFilesPathGit', customDebounce(searchFilesPathGit))
    ipcMain.handle('searchFilesNameGit', customDebounce(searchFilesNameGit))
}
