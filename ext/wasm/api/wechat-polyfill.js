var self = globalThis;
var WebAssembly = WXWebAssembly;
var URL = function () { this.searchParams = new Map(); };
var URLSearchParams = Map;
var window = {};
var crypto = { getRandomValues: (array) => { for (var i = 0; i < array.length; i++) array[i] = (Math.random() * 256) | 0 } };
function TextEncoder(encoding)
{
}
TextEncoder.prototype.encode = function (str)
{
    const escapedBytes = encodeURIComponent(str);
    const binary = unescape(escapedBytes);

    const arr = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++)
    {
        arr[i] = binary.charCodeAt(i);
    }
    
    return arr;
}
function TextDecoder(encoding)
{
}
TextDecoder.prototype.decode = function (arrLike)
{
    const byteArr = arrLike instanceof ArrayBuffer ? new Uint8Array(arrLike) : Uint8Array.from(arrLike);

    const binary = String.fromCharCode(...byteArr);
    const escapedBytes = escape(binary);
    return decodeURIComponent(escapedBytes);
}