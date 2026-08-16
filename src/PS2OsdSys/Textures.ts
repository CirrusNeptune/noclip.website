import {GSPixelStorageFormat} from "../Common/PS2/GS";
import ArrayBufferSlice from "../ArrayBufferSlice";
import * as Viewer from "../viewer";
import {GfxDevice, GfxFormat, makeTextureDescriptor2D} from "../gfx/platform/GfxPlatform";
import {assertExists} from "../util";
import {ResourceID} from "./ResourceIDs";

/**
 * PSM enum with extra software-expanded PSMCT32 representations.
 */
export enum OsdSysPixelStorageFormat {
    PSMCT32          = GSPixelStorageFormat.PSMCT32,
    PSMCT24          = GSPixelStorageFormat.PSMCT24,
    PSMCT16          = GSPixelStorageFormat.PSMCT16,
    IWhiteA8         = 0x03, // 8bpp Alpha expanded to 32bpp white RGB + A
    IBlackA8         = 0x04, // 8bpp Alpha expanded to 32bpp black RGB + A
    IA8              = 0x05, // 16bpp Intensity + Alpha expanded to 32bpp RGBA
    // Next three enums aren't actually in the original, they're hard-coded in an asset-specific loader
    I8Alpha127       = 0x06, // 8bpp Intensity expanded to 32bpp RGB + 0x7f Alpha
    RGB8Alpha1272x2  = 0x07, // 24bpp RGB expanded to 32bpp RGB + 0x7f Alpha in a 2x2 repeated tile layout
    BrowserTexture   = 0x08, // A texture with an actual header!
    PSMCT16S         = GSPixelStorageFormat.PSMCT16S,
    PSMT8            = GSPixelStorageFormat.PSMT8,
    PSMT4            = GSPixelStorageFormat.PSMT4,
    PSMT8H           = GSPixelStorageFormat.PSMT8H,
    PSMT4HL          = GSPixelStorageFormat.PSMT4HL,
    PSMT4HH          = GSPixelStorageFormat.PSMT4HH,
    PSMZ32           = GSPixelStorageFormat.PSMZ32,
    PSMZ24           = GSPixelStorageFormat.PSMZ24,
    PSMZ16           = GSPixelStorageFormat.PSMZ16,
    PSMZ16S          = GSPixelStorageFormat.PSMZ16S,
}

interface TextureInfo {
    width: number,
    height: number,
    mipCount: number,
    imageOffset: number,
    psm: OsdSysPixelStorageFormat,
    clut?: Uint8Array,
}

const AA_TEXT_CLUT = new Uint8Array([
    0x0,  0x0,  0x0,  0x0,
    0x11, 0x11, 0x11, 0x9,
    0x22, 0x22, 0x22, 0x11,
    0x33, 0x33, 0x33, 0x1A,
    0x44, 0x44, 0x44, 0x22,
    0x55, 0x55, 0x55, 0x2B,
    0x66, 0x66, 0x66, 0x33,
    0x77, 0x77, 0x77, 0x3C,
    0x88, 0x88, 0x88, 0x44,
    0x99, 0x99, 0x99, 0x4D,
    0xAA, 0xAA, 0xAA, 0x55,
    0xBB, 0xBB, 0xBB, 0x5E,
    0xCC, 0xCC, 0xCC, 0x66,
    0xDD, 0xDD, 0xDD, 0x6F,
    0xEE, 0xEE, 0xEE, 0x77,
    0xFF, 0xFF, 0xFF, 0x80
]);

const TEXTURE_INFOS: Map<ResourceID, TextureInfo> = new Map<ResourceID, TextureInfo>([
    // Opening Textures
    [ResourceID.TEXOSCE, { width: 256, height: 64, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.IA8 }],
    [ResourceID.TEXOFOG0, { width: 128, height: 128, mipCount: 1, imageOffset: 20, psm: OsdSysPixelStorageFormat.PSMCT16 }],
    [ResourceID.TEXOFOG1, { width: 64, height: 64, mipCount: 1, imageOffset: 20, psm: OsdSysPixelStorageFormat.PSMCT16 }],
    [ResourceID.TEXOFOG2, { width: 64, height: 64, mipCount: 1, imageOffset: 20, psm: OsdSysPixelStorageFormat.PSMCT16 }],
    [ResourceID.TEXOFOG3, { width: 64, height: 64, mipCount: 1, imageOffset: 20, psm: OsdSysPixelStorageFormat.PSMCT16 }],
    [ResourceID.TEXOFOG4, { width: 64, height: 64, mipCount: 1, imageOffset: 20, psm: OsdSysPixelStorageFormat.PSMCT16 }],
    // TODO: Load TEXOWAL0's mipmaps
    [ResourceID.TEXOWAL0, { width: 256, height: 256, mipCount: 3, imageOffset: 20, psm: OsdSysPixelStorageFormat.PSMCT16 }],
    [ResourceID.TEXOCRLE, { width: 64, height: 64, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.PSMCT32 }],
    [ResourceID.TEXOCRBL, { width: 64, height: 64, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.PSMCT32 }],
    [ResourceID.TEXOFLAR, { width: 128, height: 128, mipCount: 1, imageOffset: 20, psm: OsdSysPixelStorageFormat.PSMCT16 }],
    [ResourceID.TEXOREF, { width: 128, height: 128, mipCount: 1, imageOffset: 20, psm: OsdSysPixelStorageFormat.PSMCT16 }],
    [ResourceID.TEXOBLP, { width: 64, height: 64, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.IBlackA8 }],
    [ResourceID.TEXOBLPR, { width: 64, height: 64, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.IBlackA8 }],
    [ResourceID.TEXOPNGJ, { width: 512, height: 128, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.PSMT4, clut: AA_TEXT_CLUT }],
    [ResourceID.TEXOPNGE, { width: 512, height: 128, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.PSMT4, clut: AA_TEXT_CLUT }],
    [ResourceID.TEXOPNGF, { width: 512, height: 128, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.PSMT4, clut: AA_TEXT_CLUT }],
    [ResourceID.TEXOPNGS, { width: 512, height: 128, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.PSMT4, clut: AA_TEXT_CLUT }],
    [ResourceID.TEXOPNGG, { width: 512, height: 128, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.PSMT4, clut: AA_TEXT_CLUT }],
    [ResourceID.TEXOPNGI, { width: 512, height: 128, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.PSMT4, clut: AA_TEXT_CLUT }],
    [ResourceID.TEXOPNGD, { width: 512, height: 128, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.PSMT4, clut: AA_TEXT_CLUT }],
    [ResourceID.TEXOPNGP, { width: 512, height: 128, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.PSMT4, clut: AA_TEXT_CLUT }],
    [ResourceID.TEXOPNGR, { width: 512, height: 128, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.PSMT4, clut: AA_TEXT_CLUT }],
    [ResourceID.TEXOPNGK, { width: 512, height: 128, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.PSMT4, clut: AA_TEXT_CLUT }],
    [ResourceID.TEXOPNGH, { width: 512, height: 128, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.PSMT4, clut: AA_TEXT_CLUT }],
    [ResourceID.TEXOPNGC, { width: 512, height: 128, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.PSMT4, clut: AA_TEXT_CLUT }],

    // Clock Textures
    [ResourceID.TEXCFLOW, { width: 64, height: 64, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.I8Alpha127 }],
    [ResourceID.TEXCKABE, { width: 128, height: 128, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.RGB8Alpha1272x2 }],
    [ResourceID.TEXCBUMP, { width: 64, height: 64, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.I8Alpha127 }],
    [ResourceID.TEXCBINV, { width: 64, height: 64, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.I8Alpha127 }],
    [ResourceID.TEXCSMOK, { width: 64, height: 64, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.IWhiteA8 }],
    [ResourceID.TEXCREFA, { width: 64, height: 64, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.I8Alpha127 }],
    [ResourceID.TEXCNAVI, { width: 64, height: 64, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.IWhiteA8 }],
    [ResourceID.TEXCBLUR, { width: 64, height: 64, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.IWhiteA8 }],
    [ResourceID.TEXCSTSL, { width: 64, height: 64, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.IA8 }],
    [ResourceID.TEXCMARU, { width: 64, height: 64, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.PSMCT32 }],

    // Clock OOBE Textures
    [ResourceID.TEXCKLFN, { width: 135, height: 97, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.PSMCT24 }],
    [ResourceID.TEXCKLFP, { width: 137, height: 117, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.PSMCT24 }],
    [ResourceID.TEXCKLGN, { width: 368, height: 105, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.PSMCT24 }],
    [ResourceID.TEXCKLGP, { width: 368, height: 125, mipCount: 1, imageOffset: 0, psm: OsdSysPixelStorageFormat.PSMCT24 }],

    // Browser Textures (info contained in file header)
    [ResourceID.TEXBNAV1, { width: 0, height: 0, mipCount: 0, imageOffset: 0, psm: OsdSysPixelStorageFormat.BrowserTexture }],
    [ResourceID.TEXBNAV2, { width: 0, height: 0, mipCount: 0, imageOffset: 0, psm: OsdSysPixelStorageFormat.BrowserTexture }],
    [ResourceID.TEXBARRW, { width: 0, height: 0, mipCount: 0, imageOffset: 0, psm: OsdSysPixelStorageFormat.BrowserTexture }],
    [ResourceID.TEXBBTTN, { width: 0, height: 0, mipCount: 0, imageOffset: 0, psm: OsdSysPixelStorageFormat.BrowserTexture }],
    [ResourceID.TEXBCPAR, { width: 0, height: 0, mipCount: 0, imageOffset: 0, psm: OsdSysPixelStorageFormat.BrowserTexture }],
    [ResourceID.TEXBCDPB, { width: 0, height: 0, mipCount: 0, imageOffset: 0, psm: OsdSysPixelStorageFormat.BrowserTexture }],
    [ResourceID.TEXBOVAL, { width: 0, height: 0, mipCount: 0, imageOffset: 0, psm: OsdSysPixelStorageFormat.BrowserTexture }],
    [ResourceID.TEXBICHI, { width: 0, height: 0, mipCount: 0, imageOffset: 0, psm: OsdSysPixelStorageFormat.BrowserTexture }],
]);

export interface Texture extends Viewer.Texture {
}

function readPSMCT32Pixels(info: TextureInfo, data: ArrayBufferSlice, out: Uint8Array) {
    const data8 = data.createTypedArray(Uint8Array);
    const numPixels = info.width * info.height;
    for (let i = 0; i < numPixels; ++i) {
        out[i * 4] = data8[i * 4];
        out[i * 4 + 1] = data8[i * 4 + 1];
        out[i * 4 + 2] = data8[i * 4 + 2];
        out[i * 4 + 3] = data8[i * 4 + 3];
    }
}

function readPSMCT24Pixels(info: TextureInfo, data: ArrayBufferSlice, out: Uint8Array) {
    const data8 = data.createTypedArray(Uint8Array);
    const numPixels = info.width * info.height;
    for (let i = 0; i < numPixels; ++i) {
        out[i * 4] = data8[i * 3];
        out[i * 4 + 1] = data8[i * 3 + 1];
        out[i * 4 + 2] = data8[i * 3 + 2];
        out[i * 4 + 3] = 0xff;
    }
}

function readPSMCT16Pixels(info: TextureInfo, data: ArrayBufferSlice, out: Uint8Array) {
    const data16 = data.createTypedArray(Uint16Array);
    const numPixels = info.width * info.height;
    for (let i = 0; i < numPixels; ++i) {
        const p = data16[i];
        out[i * 4] = (p & 0x001F) << 3;
        out[i * 4 + 1] = (p & 0x03E0) >>> 2;
        out[i * 4 + 2] = (p & 0x7C00) >>> 7;
        out[i * 4 + 3] = (p >>> 15) ? 0xff : 0x00;
    }
}

function readIWhiteA8Pixels(info: TextureInfo, data: ArrayBufferSlice, out: Uint8Array) {
    const data8 = data.createTypedArray(Uint8Array);
    const numPixels = info.width * info.height;
    for (let i = 0; i < numPixels; ++i) {
        out[i * 4] = 0xff;
        out[i * 4 + 1] = 0xff;
        out[i * 4 + 2] = 0xff;
        out[i * 4 + 3] = data8[i];
    }
}

function readIBlackA8Pixels(info: TextureInfo, data: ArrayBufferSlice, out: Uint8Array) {
    const data8 = data.createTypedArray(Uint8Array);
    const numPixels = info.width * info.height;
    for (let i = 0; i < numPixels; ++i) {
        out[i * 4] = 0x00;
        out[i * 4 + 1] = 0x00;
        out[i * 4 + 2] = 0x00;
        out[i * 4 + 3] = data8[i];
    }
}

function readI8Pixels(info: TextureInfo, data: ArrayBufferSlice, out: Uint8Array) {
    const data8 = data.createTypedArray(Uint8Array);
    const numPixels = info.width * info.height;
    for (let i = 0; i < numPixels; ++i) {
        const intensity = data8[i * 2];
        out[i * 4] = intensity;
        out[i * 4 + 1] = intensity;
        out[i * 4 + 2] = intensity;
        out[i * 4 + 3] = data8[i * 2 + 1];
    }
}

function readI8Alpha127Pixels(info: TextureInfo, data: ArrayBufferSlice, out: Uint8Array) {
    const data8 = data.createTypedArray(Uint8Array);
    const numPixels = info.width * info.height;
    for (let i = 0; i < numPixels; ++i) {
        const intensity = data8[i];
        out[i * 4] = intensity;
        out[i * 4 + 1] = intensity;
        out[i * 4 + 2] = intensity;
        out[i * 4 + 3] = 0x7f;
    }
}

function readI8Alpha1272x2Pixels(info: TextureInfo, data: ArrayBufferSlice, out: Uint8Array) {
    function writeIntensity(x: number, y: number, intensity: number) {
        const index = y * info.width + x;
        out[index * 4] = intensity;
        out[index * 4 + 1] = intensity;
        out[index * 4 + 2] = intensity;
        out[index * 4 + 3] = 0x7f;
    }
    const data8 = data.createTypedArray(Uint8Array);
    const hw = info.width >>> 1;
    const hh = info.height >>> 1;
    for (let y = 0; y < hh; ++y) {
        for (let x = 0; x < hw; ++x) {
            const intensity = data8[y * hw + x];
            writeIntensity(x, y, intensity);
            writeIntensity(x + hw, y, intensity);
            writeIntensity(x, y + hh, intensity);
            writeIntensity(x + hw, y + hh, intensity);
        }
    }
}

function readPSMT8Pixels(info: TextureInfo, data: ArrayBufferSlice, out: Uint8Array) {
    const clut8 = assertExists(info.clut);
    const data8 = data.createTypedArray(Uint8Array);
    const numPixels = info.width * info.height;
    for (let i = 0; i < numPixels; ++i) {
        const clut0 = data8[i];
        out[i * 4] = clut8[clut0 * 4];
        out[i * 4 + 1] = clut8[clut0 * 4 + 1];
        out[i * 4 + 2] = clut8[clut0 * 4 + 2];
        out[i * 4 + 3] = clut8[clut0 * 4 + 3];
    }
}

function readPSMT4Pixels(info: TextureInfo, data: ArrayBufferSlice, out: Uint8Array) {
    const clut8 = assertExists(info.clut);
    const data8 = data.createTypedArray(Uint8Array);
    const numPixels = info.width * info.height;
    for (let i = 0; i < (numPixels + 1) >>> 1; ++i) {
        const clut0 = data8[i] & 0xf;
        const clut1 = data8[i] >>> 4;
        out[i * 8] = clut8[clut0 * 4];
        out[i * 8 + 1] = clut8[clut0 * 4 + 1];
        out[i * 8 + 2] = clut8[clut0 * 4 + 2];
        out[i * 8 + 3] = clut8[clut0 * 4 + 3];
        out[i * 8 + 4] = clut8[clut1 * 4];
        out[i * 8 + 5] = clut8[clut1 * 4 + 1];
        out[i * 8 + 6] = clut8[clut1 * 4 + 2];
        out[i * 8 + 7] = clut8[clut1 * 4 + 3];
    }
}

function parseBrowserTextureInfo(data: ArrayBufferSlice): TextureInfo {
    const header32 = data.createTypedArray(Uint32Array, 0, 5);
    const type = header32[1];
    const width = header32[4] >>> 16;
    const height = (header32[4] & 0xffff) >>> 0;

    let imageOffset = 20;
    let psm = OsdSysPixelStorageFormat.PSMCT32;
    let paletteSize = 0;
    switch (type) {
        case 0:
            imageOffset = 64;
            psm = OsdSysPixelStorageFormat.PSMT4;
            paletteSize = 32;
            break;
        case 1:
            imageOffset = 544;
            psm = OsdSysPixelStorageFormat.PSMT8;
            paletteSize = 512;
            break;
        case 2:
            psm = OsdSysPixelStorageFormat.PSMCT16;
            break;
        case 3:
            psm = OsdSysPixelStorageFormat.PSMCT24;
            break;
        case 4:
            psm = OsdSysPixelStorageFormat.PSMCT32;
            break;
        default:
            throw "Unknown browser texture header type";
    }

    const clut = paletteSize
        ? data.slice(20, 20 + paletteSize).createTypedArray(Uint8Array)
        : undefined;

    return {
        width,
        height,
        mipCount: 1,
        imageOffset,
        psm,
        clut
    }
}

// Keep the raw pixels of these around to build TEXOFOGC.
let TEXOFOG4Pixels: Uint8Array | null = null;
let TEXOFOG2Pixels: Uint8Array | null = null;
let TEXOFOG1Pixels: Uint8Array | null = null;

// Keep the raw pixels of these around to build TEXOCUBE.
let TEXOBLPRPixels: Uint8Array | null = null;
let TEXOBLPPixels: Uint8Array | null = null;

export function loadTexture(id: ResourceID, data: ArrayBufferSlice, device: GfxDevice): Texture {
    let info = assertExists(TEXTURE_INFOS.get(id));
    if (info.psm === OsdSysPixelStorageFormat.BrowserTexture) {
        info = parseBrowserTextureInfo(data);
    }

    const dataSlice = data.slice(info.imageOffset);

    const pixels = new Uint8Array(info.width * info.height * 4);
    switch (info.psm) {
        case OsdSysPixelStorageFormat.PSMCT32:
            readPSMCT32Pixels(info, dataSlice, pixels);
            break;
        case OsdSysPixelStorageFormat.PSMCT24:
            readPSMCT24Pixels(info, dataSlice, pixels);
            break;
        case OsdSysPixelStorageFormat.PSMCT16:
            readPSMCT16Pixels(info, dataSlice, pixels);
            break;
        case OsdSysPixelStorageFormat.IWhiteA8:
            readIWhiteA8Pixels(info, dataSlice, pixels);
            break;
        case OsdSysPixelStorageFormat.IBlackA8:
            readIBlackA8Pixels(info, dataSlice, pixels);
            break;
        case OsdSysPixelStorageFormat.IA8:
            readI8Pixels(info, dataSlice, pixels);
            break;
        case OsdSysPixelStorageFormat.I8Alpha127:
            readI8Alpha127Pixels(info, dataSlice, pixels);
            break;
        case OsdSysPixelStorageFormat.RGB8Alpha1272x2:
            readI8Alpha1272x2Pixels(info, dataSlice, pixels);
            break;
        case OsdSysPixelStorageFormat.PSMT8:
            readPSMT8Pixels(info, dataSlice, pixels);
            break;
        case OsdSysPixelStorageFormat.PSMT4:
            readPSMT4Pixels(info, dataSlice, pixels);
            break;
        default:
            throw "Unknown PSM";
    }

    if (id === ResourceID.TEXOFOG4)
        TEXOFOG4Pixels = pixels;
    else if (id === ResourceID.TEXOFOG2)
        TEXOFOG2Pixels = pixels;
    else if (id === ResourceID.TEXOFOG1)
        TEXOFOG1Pixels = pixels;
    else if (id === ResourceID.TEXOBLPR)
        TEXOBLPRPixels = pixels;
    else if (id === ResourceID.TEXOBLP)
        TEXOBLPPixels = pixels;

    const gfxTexture = device.createTexture(
        makeTextureDescriptor2D(GfxFormat.U8_RGBA_NORM, info.width, info.height, 1));

    device.uploadTextureData(gfxTexture, 0, [pixels]);
    device.setResourceName(gfxTexture, ResourceID[id]);

    const extraInfo = new Map<string, string>();
    extraInfo.set("Format", OsdSysPixelStorageFormat[info.psm]);
    return {
        gfxTexture,
        extraInfo
    };
}

// For optimal drawing of fog layers, pack TEXOFOG4,2,1 into one texture.
// See Render/OpeningFog.ts for implementation.
export function buildTEXOFOGC(device: GfxDevice): Texture {
    const TEXOFOG4 = assertExists(TEXOFOG4Pixels);
    const TEXOFOG2 = assertExists(TEXOFOG2Pixels);
    const TEXOFOG1 = assertExists(TEXOFOG1Pixels);

    const pixels = new Uint8Array(64 * 64 * 4);
    for (let i = 0; i < 64 * 64; ++i) {
        pixels[i * 4] = TEXOFOG4[i * 4];
        pixels[i * 4 + 1] = TEXOFOG2[i * 4];
        pixels[i * 4 + 2] = TEXOFOG1[i * 4];
        pixels[i * 4 + 3] = 0xff;
    }

    // Done with these, let GC get em
    TEXOFOG4Pixels = null;
    TEXOFOG2Pixels = null;
    TEXOFOG1Pixels = null;

    const gfxTexture = device.createTexture(
        makeTextureDescriptor2D(GfxFormat.U8_RGBA_NORM, 64, 64, 1));

    device.uploadTextureData(gfxTexture, 0, [pixels]);
    device.setResourceName(gfxTexture, ResourceID[ResourceID.TEXOFOGC]);

    const extraInfo = new Map<string, string>();
    extraInfo.set("Format", OsdSysPixelStorageFormat[OsdSysPixelStorageFormat.PSMCT32]);
    return {
        gfxTexture,
        extraInfo
    };
}

// For optimal drawing of multipass cube, pack alpha values of TEXOBLPR,TEXOBLP
// into one texture. See Render/MultipassCube.ts for implementation.
export function buildTEXOBLPC(device: GfxDevice): Texture {
    const TEXOBLPR = assertExists(TEXOBLPRPixels);
    const TEXOBLP = assertExists(TEXOBLPPixels);

    const pixels = new Uint8Array(64 * 64 * 4);
    for (let i = 0; i < 64 * 64; ++i) {
        pixels[i * 4] = TEXOBLPR[i * 4 + 3];
        pixels[i * 4 + 1] = TEXOBLP[i * 4 + 3];
        pixels[i * 4 + 2] = 0x0;
        pixels[i * 4 + 3] = 0xff;
    }

    // Done with these, let GC get em
    TEXOBLPRPixels = null;
    TEXOBLPPixels = null;

    const gfxTexture = device.createTexture(
        makeTextureDescriptor2D(GfxFormat.U8_RGBA_NORM, 64, 64, 1));

    device.uploadTextureData(gfxTexture, 0, [pixels]);
    device.setResourceName(gfxTexture, ResourceID[ResourceID.TEXOBLPC]);

    const extraInfo = new Map<string, string>();
    extraInfo.set("Format", OsdSysPixelStorageFormat[OsdSysPixelStorageFormat.PSMCT32]);
    return {
        gfxTexture,
        extraInfo
    };
}
