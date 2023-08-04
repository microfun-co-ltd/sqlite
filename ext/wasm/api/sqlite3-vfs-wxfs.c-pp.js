/*
  2023-08-01

  The author disclaims copyright to this source code.  In place of a
  legal notice, here is a blessing:

  *   May you do good and not evil.
  *   May you find forgiveness for yourself and forgive others.
  *   May you share freely, never taking more than you give.
  * 
  ***********************************************************************

  This file implements the VFS plugin for WeChar mini App environment.
  This file is intended to be appended to the main sqlite3 JS deliverable
  somewhere after sqlite3-api-oo1.js and before sqlite3-api-cleanup.js.
*/
'use strict';
globalThis.sqlite3ApiBootstrap.initializers.push(function (sqlite3){
    const toss = sqlite3.util.toss;
    const capi = sqlite3.capi;
    const wasm = sqlite3.wasm;
    const sqlite3_vfs = capi.sqlite3_vfs;
    const sqlite3_file = capi.sqlite3_file;
    const sqlite3_io_methods = capi.sqlite3_io_methods;
    const fs = wx.getFileSystemManager();
    const state = { lastError: null };

    const __openHandles = Object.create(null);
    const __openFiles = Object.create(null);


    const sq3Vfs = new sqlite3_vfs();
    const sq3IoMethods = new sqlite3_io_methods();

    /**
        Impls for the sqlite3_io_methods methods. Maintenance reminder:
        members are in alphabetical order to simplify finding them.
    */
    const jsIoMethods =
    {
        xCheckReservedLock: function (pFile, pOut)
        {
            const file = __openHandles[pFile];

            //console.log('xCheckReservedLock ' + file.pathName);

            state.lastError = null;

            wasm.poke(pOut, file.lockType ? 1 : 0, 'i32');

            return 0;
        },
        xClose: function (pFile)
        {
            state.lastError = null;
            const file = __openHandles[pFile];
            if (file)
            {
                //console.log(`xClose ${file.pathName}`);

                try
                {
                    // Really close the file handle
                    fs.closeSync({ fd: file.handle });

                    // Delete the file if necessary
                    if (file.flags & capi.SQLITE_OPEN_DELETEONCLOSE)
                    {
                        fs.unlinkSync(file.pathName);
                    }

                    // Remove the handle mapping
                    delete __openHandles[pFile];
                }
                catch (e)
                {
                    console.log(e);
                    state.lastError = e;
                    return capi.SQLITE_IOERR;
                }
            }
            return 0;
        },
        xDeviceCharacteristics: function (pFile)
        {
            return capi.SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN;
        },
        xFileControl: function (pFile, opId, pArg)
        {
            state.lastError = null;
            return capi.SQLITE_NOTFOUND;
        },
        xFileSize: function (pFile, pSz64)
        {
            state.lastError = null;
            const file = __openHandles[pFile];

            //console.log(`xFileSize ${file.pathName}`);

            try
            {
                const stat = fs.fstatSync({ fd: file.handle });

                wasm.poke32(pSz64, stat.size);
                wasm.poke32(pSz64 + 4, 0);

                //console.log(`xFileSize ${file.pathName} ${stat.size}`);
            }
            catch (e)
            {
                //console.log(e);
                state.lastError = e;
                return capi.SQLITE_IOERR;
            }

            return 0;
        },
        xLock: function (pFile, lockType)
        {
            const file = __openHandles[pFile];
            file.lockType = lockType;
            return 0;
        },
        xRead: function (pFile, pDest, n, offset64)
        {
            state.lastError = null;
            const file = __openHandles[pFile];

            //console.log(`xRead ${file.pathName} ${n} @ ${offset64}`);

            try
            {
                const result = fs.readSync({ fd: file.handle, arrayBuffer: wasm.heap8u().buffer, offset: pDest, length: n, position: Number(offset64) });
                if (result.bytesRead < n)
                {
                    wasm.heap8u().fill(0, pDest + result.bytesRead, pDest + n);
                    return capi.SQLITE_IOERR_SHORT_READ;
                }

                //console.log("xRead succeeded: " + result.bytesRead);

                return 0;
            }
            catch (e)
            {
                //console.log(e);
                state.lastError = e;
                return capi.SQLITE_IOERR;
            }
        },
        xSectorSize: function (pFile)
        {
            return 2048;
        },
        xSync: function (pFile, flags)
        {
            state.lastError = null;
            //const file = __openHandles[pFile];
            // WeChat does not support flush
            return 0;
        },
        xTruncate: function (pFile, sz64)
        {
            state.lastError = null;
            const file = __openHandles[pFile];
            //console.log(`xTruncate ${file.pathName} ${sz64}`);
            try
            {
                fs.truncateSync({ filePath: file.pathName, length: Number(sz64) });
                return 0;
            }
            catch (e)
            {
                //console.log(e);
                state.lastError = e;
                return capi.SQLITE_IOERR;
            }
        },
        xUnlock: function (pFile, lockType)
        {
            const file = __openHandles[pFile];
            file.lockType = lockType;
            return 0;
        },
        xWrite: function (pFile, pSrc, n, offset64)
        {
            state.lastError = null;
            const file = __openHandles[pFile];

            //console.log(`xWrite ${file.pathName} ${n} ${offset64}`);

            try
            {
                //
                const heapBuf = wasm.heap8u().buffer;
                let buf = heapBuf;
                let offset = pSrc;
                if (heapBuf.byteLength >= 10 * 1024 * 1024)
                {
                    buf = heapBuf.slice(pSrc, pSrc + n);
                    offset = 0;
                    //console.log("Buf size " + heapBuf.byteLength + " >= 10MB, sliced " + n + " bytes at " + pSrc + ": " + buf.byteLength);
                }

                const result = fs.writeSync({ fd: file.handle, data: buf, offset: offset, length: n, position: Number(offset64) });
                return result.bytesWritten === n ? 0 : capi.SQLITE_IOERR;
            }
            catch (e)
            {
                //console.log(e);
                state.lastError = e;
                return capi.SQLITE_IOERR;
            }
        }
    }; // ioMethods


    //
    // Generates a random ASCII string len characters long, intended for
    // use as a temporary file name.
    //
    const randomFilename = function f(len = 16)
    {
        if (!f._chars)
        {
            f._chars = "abcdefghijklmnopqrstuvwxyz" +
                "ABCDEFGHIJKLMNOPQRSTUVWXYZ" +
                "012346789";
            f._n = f._chars.length;
        }
        const a = [];
        for (let i = 0; i < len; ++i)
        {
            const ndx = Math.random() * (f._n * 64) % f._n | 0;
            a[i] = f._chars[ndx];
        }
        return a.join("");
    };

    //
    // Impls for the sqlite3_vfs methods. Maintenance reminder: members
    // are in alphabetical order to simplify finding them.
    //
    const jsVfsMethods =
    {
        xAccess: function (pVfs, zName, flags, pOut)
        {
            const fileName = wasm.cstrToJs(zName);
            //console.log("xAccess(" + fileName + ")");
            try
            {
                fs.accessSync(fileName);
                if (flags == sqlite3.capi.SQLITE_OPEN_CREATE)
                {
                    wasm.poke32(pOut, 1);
                }
                else
                { // Need to test if it is readable/writable

                    // Theorically we should do following, but in WeChat, there is only one writtable folder, so we can determine whether it is writable by soly looking at the path
                    //fs.openSync(fileName, "w");

                    if (fileName.startsWith(wx.env.USER_DATA_PATH))
                    {
                        wasm.poke32(pOut, 1);
                    }
                    else
                    {
                        wasm.poke32(pOut, 0);
                    }
                }
            }
            catch (e)
            { // No such file or no permissin to access at all
                state.lastError = e;
                wasm.poke32(pOut, 0);
            }

            return 0;
        },
        xCurrentTime: function (pVfs, pOut)
        {
            wasm.poke(pOut, 2440587.5 + (new Date().getTime() / 86400000), 'double');
            return 0;
        },
        xCurrentTimeInt64: function (pVfs, pOut)
        {
            wasm.poke(pOut, (2440587.5 * 86400000) + new Date().getTime(), 'i64');
            return 0;
        },
        xDelete: function (pVfs, zName, doSyncDir)
        {
            const fileName = wasm.cstrToJs(zName);
            //console.log(`xDelete ${fileName}`);
            try
            {
                fs.unlinkSync(fileName);
                return 0;
            }
            catch (e)
            {
                state.lastError = e;
                return capi.SQLITE_IOERR_DELETE;
            }
        },
        xFullPathname: function (pVfs, zName, nOut, pOut)
        {
            //console.log(`xFullPathname ${wasm.cstrToJs(zName)}`);
            const i = wasm.cstrncpy(pOut, zName, nOut);
            return i < nOut ? 0 : capi.SQLITE_CANTOPEN;
        },
        xGetLastError: function (pVfs, nOut, pOut)
        {
            const e = state.lastError;
            if (e)
            {
                state.lastError = null;
                const scope = wasm.scopedAllocPush();
                try
                {
                    const [cMsg, n] = wasm.scopedAllocCString(e.message, true);
                    wasm.cstrncpy(pOut, cMsg, nOut);
                    if (n > nOut) wasm.poke8(pOut + nOut - 1, 0);
                }
                catch (e)
                {
                    return capi.SQLITE_NOMEM;
                }
                finally
                {
                    wasm.scopedAllocPop(scope);
                }
            }
            return 0;
        },
        xSleep: function (pVfs, ms)
        {
            // There is no real sleep function in JavaScript, and the Atomics.wait() cannot be used in main thread.
            return 0;
        },
        xRandomness: function (pVfs, nOut, pOut)
        {
            const heap = wasm.heap8u();
            let i = 0;
            for (; i < nOut; ++i) heap[pOut + i] = (Math.random() * 255000) & 0xFF;
            return i;
        },
        xOpen: function f(pVfs, zName, pFile, flags, pOutFlags)
        {
            const fileName = zName !== 0 ? wasm.cstrToJs(zName) : randomFilename();
            //console.log(`xOpen ${fileName} ${flags}`);
            let fh;
            try
            {
                const isExclusive = (flags & capi.SQLITE_OPEN_EXCLUSIVE);
                const isDelete = (flags & capi.SQLITE_OPEN_DELETEONCLOSE);
                const isCreate = (flags & capi.SQLITE_OPEN_CREATE);
                const isReadonly = (flags & capi.SQLITE_OPEN_READONLY);
                const isReadWrite = (flags & capi.SQLITE_OPEN_READWRITE);

                // Check the following statements are true:
                //
                //   (a) Exactly one of the READWRITE and READONLY flags must be set, and
                //   (b) if CREATE is set, then READWRITE must also be set, and
                //   (c) if EXCLUSIVE is set, then CREATE must also be set.
                //   (d) if DELETEONCLOSE is set, then CREATE must also be set.
                //
                assert((isReadonly == 0 || isReadWrite == 0) && (isReadWrite || isReadonly));
                assert(isCreate == 0 || isReadWrite);
                assert(isExclusive == 0 || isCreate);
                assert(isDelete == 0 || isCreate);

                let wxFlags;

                // SQLITE_OPEN_EXCLUSIVE is used to make sure that a new file is
                // created. SQLite doesn't use it to indicate "exclusive access"
                // as it is usually understood.
                if (isExclusive)
                { // Creates a new file, only if it does not already exist. If the file exists, it fails.
                    wxFlags = "wx+";
                }
                else if (isCreate)
                { // Open existing file, or create if it doesn't exist
                    wxFlags = "a+";
                }
                else if (isReadWrite)
                { // Opens a file readwrite, only if it exists.
                    wxFlags = "r+";
                }
                else
                { // Opens a file readonly, only if it exists.
                    wxFlags = "r";
                }

                //console.log(`xOpen ${fileName} ${wxFlags}`);

                // Really open the file, note WeChat returns the file handle as a string.
                fh = fs.openSync({ filePath: fileName, flag: wxFlags });

                // Special treatment, if the flags is "a+", we should change to "r+"
                if (wxFlags === "a+")
                {
                    //console.log("Switching mode from a+ to r+: " + fh);
                    const fh2 = fs.openSync({ filePath: fileName, flag: "r+" });

                    fs.closeSync({ fd: fh });

                    fh = fh2;
                }

                // Create a file handle control block
                const file =
                {
                    id: pFile,
                    handle: fh, // string
                    pathName: fileName,
                    flags: flags,
                    lockType: capi.SQLITE_LOCK_NONE,
                };

                __openHandles[pFile] = file;

                // Initialize the sqlite3_file structure
                const sq3File = new capi.sqlite3_file(pFile);
                sq3File.$pMethods = sq3IoMethods.pointer;
                sq3File.dispose();

                // Write back the flags
                // TODO: We should remove the flags we do not support
                wasm.poke32(pOutFlags, flags);

                //console.log("xOpen succeeded: " + fh);

                fh = null;

                return 0;
            }
            catch (e)
            {
                //console.log(e);
                state.lastError = e;
                return capi.SQLITE_CANTOPEN;
            }
            finally
            {
                if (fh)
                {
                    fs.closeSync({ fd: fh });
                }
            }
        }/*xOpen()*/
    }; // jsVfsMethods

    // Reuse built-in xRandomness and xSleep if possible
    const pDVfs = capi.sqlite3_vfs_find(null); // *pointer to default VFS*
    const dVfs = pDVfs ? new sqlite3_vfs(pDVfs) : null; // dVfs will be null when sqlite3 is built with SQLITE_OS_OTHER.
    if (dVfs)
    {
        if (dVfs.$xRandomness)
        {
            sq3Vfs.$xRandomness = dVfs.$xRandomness;
            delete jsVfsMethods.xRandomness;
        }
        if (dVfs.$xSleep)
        {
            sq3Vfs.$xSleep = dVfs.$xSleep;
            delete jsVfsMethods.xSleep;
        }
    }

    // Fill in the sqlite3_io_methods structure
    sq3IoMethods.$iVersion = 1;

    // Fill in the sqlite3_vfs structure
    sq3Vfs.$iVersion = 2;
    sq3Vfs.$szOsFile = capi.sqlite3_file.structInfo.sizeof;
    sq3Vfs.$mxPathname = 1024;
    sq3Vfs.$zName = wasm.allocCString("wxfs");
    sq3Vfs.$xDlOpen = sq3Vfs.$xDlError = sq3Vfs.$xDlSym = sq3Vfs.$xDlClose = null;
    sq3Vfs.ondispose =
        [
            '$zName', sq3Vfs.$zName,
            'cleanup default VFS wrapper', () => (dVfs ? dVfs.dispose() : null),
            'cleanup sq3IoMethods', () => sq3IoMethods.dispose()
        ];

    //console.log("Registering WeChat VFS");

    const loadProxies = async function (wasmSide, jsSide)
    {
        const exported = {};
        for (let funcName of Object.keys(jsSide))
        {
            const func = jsSide[funcName];
            const wasmSig = wasmSide.memberSignature(funcName, true);
            const key = wasmSig.replace(/\(|\)/g, "");
            const res = await WXWebAssembly.instantiate("lib/jsFuncToWasm/" + key + ".wasm", { e: { f: func } });

            exported[funcName] = res.instance.exports.f;
        }

        return exported;
    }

    globalThis.sqlite3ApiBootstrap.initializersAsync.push(async (sqlite3) =>
    {
        const exportedJsIoMethods = await loadProxies(sq3IoMethods, jsIoMethods);
        const exportedJsVfsMethods = await loadProxies(sq3Vfs, jsVfsMethods);

        // Link JavaScript methods into WASM and register the VFS also
        sqlite3.vfs.installVfs
            (
                {
                    io: { struct: sq3IoMethods, methods: exportedJsIoMethods },
                    vfs: { struct: sq3Vfs, methods: exportedJsVfsMethods, asDefault: true }
                }
            );
    });


}/*sqlite3ApiBootstrap.initializers.push()*/);
