import ArrayBufferSlice from "../ArrayBufferSlice";
import { assertExists } from "../util";
import { HD, parseHD, SQ, parseSQ } from "./OsdSnd/OsdSnd";

const RESET = new Uint8Array([0x52, 0x45, 0x53, 0x45, 0x54, 0, 0, 0, 0, 0]);

function findInBuffer(needle: Uint8Array, haystack: Uint8Array): number {
    let needleCur = 0;
    for (let i = 0; i < haystack.byteLength; ++i) {
        if (haystack[i] === needle[needleCur]) {
            ++needleCur;
            if (needleCur == needle.byteLength) {
                return i + 1 - needleCur;
            }
        } else {
            needleCur = 0;
        }
    }
    return -1;
}

function decompress(data: ArrayBufferSlice): ArrayBufferSlice {
    const length = data.createTypedArray(Uint32Array, 0, 4)[0];
    const src = data.createTypedArray(Uint8Array);
    const dst = new Uint8Array(length);
    let si = 4;
    let di = 0;
    let run = 0;
    let desc = 0;
    let mask = 0;
    let shift = 0;

    function rd(buf: Uint8Array, idx: number) {
        return idx >= 0 && idx < buf.length ? buf[idx] : 0;
    }

    while (di <= length) {
        if (run === 0) {
            run = 30
            desc = 0
            for (let i = 0; i < 4; ++i) {
                desc = (desc << 8) | rd(src, si)
                si += 1
            }
            const n = desc & 3
            shift = 14 - n
            mask = 0x3FFF >>> n
        }
        if ((desc & (1 << (run + 1))) === 0) {
            if (di < length) {
                dst[di] = rd(src, si)
            }
            di += 1
            si += 1
        } else {
            let h = rd(src, si) << 8
            si += 1
            h |= rd(src, si)
            si += 1
            let co = di - ((h & mask) + 1)
            for (let i = 0, end = 2 + (h >> shift) + 1; i < end; ++i) {
                if (di < length) {
                    dst[di] = rd(dst, co)
                }
                di += 1
                co += 1
            }
        }
        run -= 1
    }

    return ArrayBufferSlice.fromView(dst);
}

class ROMDir {
    constructor(public name: string, public extInfoSize: number, public fileSize: number, public fileOffset: number) {
    }

    static parse(buffer: ArrayBufferSlice, fileOffset: number): ROMDir {
        let nameEnd = buffer.createTypedArray(Uint8Array, 0, 10).indexOf(0);
        if (nameEnd === -1) {
            nameEnd = 10;
        }
        const name = new TextDecoder("utf-8").decode(buffer.createTypedArray(Uint8Array, 0, nameEnd));
        const extInfoSize = buffer.createTypedArray(Uint16Array, 10, 2)[0];
        const fileSize = buffer.createTypedArray(Uint32Array, 12, 4)[0];
        return new ROMDir(name, extInfoSize, fileSize, fileOffset);
    }

    public get(imageData: ArrayBufferSlice): ArrayBufferSlice {
        return imageData.slice(this.fileOffset, this.fileOffset + this.fileSize);
    }
}

class ROMImage {
    constructor(public buffer: ArrayBufferSlice, public romdirMap: Map<string, ROMDir>) {
    }

    static parse(buffer: ArrayBufferSlice): ROMImage {
        let romdirCur = findInBuffer(RESET, buffer.createTypedArray(Uint8Array));
        let fileOffset = 0
        let romdirMap: Map<string, ROMDir> = new Map();
        while (true) {
            const romdir = ROMDir.parse(buffer.slice(romdirCur, romdirCur + 16), fileOffset);
            fileOffset += (romdir.fileSize + 15) >>> 4 << 4;
            if (romdir.name === "") {
                break;
            }
            romdirMap.set(romdir.name, romdir);
            romdirCur += 16;
        }
        return new ROMImage(buffer, romdirMap);
    }

    public get(name: string): ArrayBufferSlice {
        return assertExists(this.romdirMap.get(name)).get(this.buffer);
    }
}

export interface SequencePair {
    hd: HD;
    sq: SQ;
}

export class BIOSROM {
    public sequences: Map<string, SequencePair> = new Map<string, SequencePair>();
    
    static readonly SEQUENCES = [
        "SNDBOOTS",
        "SNDTNNLS",
        "SNDCLOKS",
        "SNDTM30S",
        "SNDTM60S",
        "SNDLOGOS",
        "SNDWARNS",
        "SNDRCLKS"
    ];

    public TEXOPNGD: ArrayBufferSlice;

    constructor(biosBuffer: ArrayBufferSlice) {
        const mainImage = ROMImage.parse(biosBuffer);

        const sndImage = ROMImage.parse(mainImage.get("SNDIMAGE"));
        const sndBootB = decompress(sndImage.get("SNDBOOTB"));
        const sndBootH = parseHD(decompress(sndImage.get("SNDBOOTH")), sndBootB.createTypedArray(Uint8Array));
        for (let i = 0; i < BIOSROM.SEQUENCES.length; ++i) {
            const name = BIOSROM.SEQUENCES[i];
            const pair: SequencePair = {
                hd: sndBootH,
                sq: parseSQ(decompress(sndImage.get(name)))
            };
            this.sequences.set(name, pair);
        }

        const texImage = ROMImage.parse(mainImage.get("TEXIMAGE"));
        const comp = texImage.get("TEXOPNGD");
        const decomp = decompress(comp);
        this.TEXOPNGD = decomp;
    }
}
