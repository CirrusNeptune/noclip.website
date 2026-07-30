import {SPU2, SpuRateMode, SpuVoiceAttr} from "./SPU2";
import ArrayBufferSlice from "../../ArrayBufferSlice";
import {assert, assertExists, nArray} from "../../util";
import {clamp} from "../../MathHelpers";
import { IS_DEVELOPMENT } from "../../BuildVersion.js";

interface HDTone {
    noteMin: number;
    noteMax: number;
    keyRoot: number;
    bendSixteenths: number;
    offset: number;
    adsr1: number;
    adsr2: number;
    volOverride: number;
    vol: number;
    pan: number;
    pitchBendMultiplier: number;
    breathControlIndex: number;
    toneFlags: number;
}

function parseHDTone(data: ArrayBufferSlice): HDTone {
    const u8s = data.createTypedArray(Uint8Array);
    return {
        noteMin: u8s[0],
        noteMax: u8s[1],
        keyRoot: u8s[2],
        bendSixteenths: u8s[3],
        offset: data.createTypedArray(Uint16Array, 4, 1)[0],
        adsr1: data.createTypedArray(Uint16Array, 6, 1)[0],
        adsr2: data.createTypedArray(Uint16Array, 8, 1)[0],
        volOverride: u8s[10],
        vol: u8s[11],
        pan: u8s[12],
        pitchBendMultiplier: u8s[13],
        breathControlIndex: u8s[14],
        toneFlags: u8s[15],
    }
}

interface HDInstrument {
    index: number;
    sfx: boolean;
    multiToneFlag: boolean
    volume: number;
    pan: number;
    unknown: number;
    pitchBendMultiplier: number;
    breathControlIndex: number;
    sfxStartingNote: number;
    tones: HDTone[];
}

function parseHDInstrument(data: ArrayBufferSlice, index: number): HDInstrument {
    const u8s = data.createTypedArray(Uint8Array, 0, 8);
    const sfx = u8s[0] === 0xff;
    const numTones = (sfx ? u8s[7] : (u8s[0] & 0x7f)) + 1;
    const tones = new Array(numTones);
    let toneOffset = 8;
    for (let i = 0; i < numTones; ++i) {
        tones[i] = parseHDTone(data.slice(toneOffset, toneOffset + 16));
        toneOffset += 16;
    }
    return {
        index,
        sfx,
        multiToneFlag: (u8s[0] & 0x80) !== 0,
        volume: u8s[1],
        pan: u8s[2],
        unknown: u8s[3],
        pitchBendMultiplier: u8s[4],
        breathControlIndex: u8s[5],
        sfxStartingNote: u8s[6],
        tones
    }
}

interface HDVelocities {
    unk: number;
    volumes: Uint8Array;
}

function parseHDVelocities(data: ArrayBufferSlice): HDVelocities {
    return {
        unk: data.createTypedArray(Uint16Array, 0, 1)[0],
        volumes: data.createTypedArray(Uint8Array, 2, 128)
    };
}

export interface HD {
    sampleData: Uint8Array;
    instruments: (HDInstrument|null)[];
    velocities: HDVelocities;
}

export function parseHD(data: ArrayBufferSlice, sampleData: Uint8Array): HD {
    const fileOffsets = data.createTypedArray(Uint32Array, 16, 28);
    const instrumentsOffset = fileOffsets[0];
    const velocitiesOffset = fileOffsets[1];

    assert(instrumentsOffset !== 0xffffffff, "HD does not contain an instruments file");
    assert(velocitiesOffset !== 0xffffffff, "HD does not contain a velocities file");

    const numInstruments = data.createTypedArray(Uint16Array, instrumentsOffset, 1)[0] + 1;
    const instrumentOffsets = data.createTypedArray(Uint16Array, instrumentsOffset + 2, numInstruments);
    const instruments = new Array(numInstruments);
    for (let i = 0; i < numInstruments; ++i) {
        const offset = instrumentOffsets[i];
        instruments[i] = offset !== 0xffff
            ? parseHDInstrument(data.slice(instrumentsOffset + offset), i)
            : null;
    }

    return {
        sampleData,
        instruments,
        velocities: parseHDVelocities(data.slice(velocitiesOffset))
    };
}

interface SQChannel {
    unknown: number;
    index: number;
    program: number;
    volume: number;
    pan: number;
    unknown2: number;
    modulation: number;
    pitchBend: number;
    priority: number;
    breath: number;
    unknown3: number;
    adjVolume: number;
    unknown4: number;
}

function parseSQChannel(data: ArrayBufferSlice): SQChannel {
    const u8s = data.createTypedArray(Uint8Array);
    return {
        unknown: u8s[0],
        index: u8s[1],
        program: u8s[2],
        volume: u8s[3],
        pan: u8s[4],
        unknown2: data.createTypedArray(Uint32Array, 5, 1)[0],
        modulation: u8s[9],
        pitchBend: u8s[10],
        priority: u8s[11],
        breath: u8s[12],
        unknown3: u8s[13],
        adjVolume: u8s[14],
        unknown4: u8s[15],
    }
}

function makeSQChannel(): SQChannel {
    return {
        unknown: 0,
        index: 0,
        program: 0,
        volume: 0,
        pan: 0,
        unknown2: 0,
        modulation: 0,
        pitchBend: 0,
        priority: 0,
        breath: 0,
        unknown3: 0,
        adjVolume: 0,
        unknown4: 0,
    };
}

function cloneSQChannel(other: SQChannel): SQChannel {
    return {
        unknown: other.unknown,
        index: other.index,
        program: other.program,
        volume: other.volume,
        pan: other.pan,
        unknown2: other.unknown2,
        modulation: other.modulation,
        pitchBend: other.pitchBend,
        priority: other.priority,
        breath: other.breath,
        unknown3: other.unknown3,
        adjVolume: other.adjVolume,
        unknown4: other.unknown4,
    };
}

const NUM_MIDI_CHANNELS = 16;

export interface SQ {
    masterVolume: number;
    ticksPerQuarterNote: number;
    tempo: number;
    channels: SQChannel[];
    midiData: Uint8Array;
}

export function parseSQ(data: ArrayBufferSlice): SQ {
    const u16s = data.createTypedArray(Uint16Array);
    const masterVolume = u16s[0];
    const ticksPerQuarterNote = u16s[1];
    const tempo = u16s[2];

    const channels = new Array(NUM_MIDI_CHANNELS);
    let channelOffset = 16;
    for (let i = 0; i < NUM_MIDI_CHANNELS; ++i) {
        channels[i] = parseSQChannel(data.slice(channelOffset, channelOffset + 16));
        channelOffset += 16;
    }

    const midiData = data.createTypedArray(Uint8Array, 272);

    return {
        masterVolume,
        ticksPerQuarterNote,
        tempo,
        channels,
        midiData
    };
}

export interface SequenceState {
    midiStatus: number;
    lastMidiStatus: number;
    midiOp1: number;
    midiOp2: number;
    secondsPerTick: number;
    keyOnVoiceBits: number;
    keyOffVoiceBits: number;
    midiCur: number;
    sq: SQ | null;
    hd: HD | null;
    playing: boolean;
    loopCounter: number;
    loopThisTick: boolean;
    midiStatusAtLoopStart: number;
    loopCount: number;
    preventNRPNLSBUpdate: boolean;
    preventDataEntryNRPNLSBUpdate: boolean;
    midiCurAtLoopStart: number;
    tempo: number;
    ticksPerQuarterNote: number;
    channels: SQChannel[];

    curChannel: SQChannel | null;
    curInstrument: HDInstrument | null;
    startTime: number | null;
    msgTime: number;
}

function makeSequenceState(): SequenceState {
    return {
        midiStatus: 0,
        lastMidiStatus: 0,
        midiOp1: 0,
        midiOp2: 0,
        secondsPerTick: 0,
        keyOnVoiceBits: 0,
        keyOffVoiceBits: 0,
        midiCur: 0,
        sq: null,
        hd: null,
        playing: false,
        loopCounter: 0,
        loopThisTick: false,
        midiStatusAtLoopStart: 0,
        loopCount: 0,
        preventNRPNLSBUpdate: false,
        preventDataEntryNRPNLSBUpdate: false,
        midiCurAtLoopStart: 0,
        tempo: 0,
        ticksPerQuarterNote: 0,
        channels: nArray(NUM_MIDI_CHANNELS, makeSQChannel),
        curChannel: null,
        curInstrument: null,
        startTime: null,
        msgTime: 0,
    }
}

interface VoiceState {
    allocated: boolean;
    midiNote: number;
    midiChannel: number;
    seq: SequenceState | null;
    keyOff: boolean;
    lruAgeCountdown: number;
    allowsSustain: boolean;
    toneIndex: number;
    breathModulation: number;
    breathAccumulator: number;
    enableModulation: boolean;
    modulation: number;
    hd: HD | null;
    instVolume: number;
    velVolume: number;
    toneVolume: number;
    panLeftVolume: number;
    panRightVolume: number;
    chanVolume: number;
    masterVolume: number;
    tonePitchBend: number;
    chanPitchBend: number;
    pitchBendMultiplier: number;
    breath: number;
    keyRoot: number;
    volumeOverride: number;
    chanPan: number;
    tonePan: number;
}

function makeVoiceState(): VoiceState {
    return {
        allocated: false,
        midiNote: 0,
        midiChannel: 0,
        seq: null,
        keyOff: false,
        lruAgeCountdown: 0,
        allowsSustain: false,
        toneIndex: 0,
        breathModulation: 0,
        breathAccumulator: 0,
        enableModulation: false,
        modulation: 0,
        hd: null,
        instVolume: 0,
        velVolume: 0,
        toneVolume: 0,
        panLeftVolume: 0,
        panRightVolume: 0,
        chanVolume: 0,
        masterVolume: 0,
        tonePitchBend: 0,
        chanPitchBend: 0,
        pitchBendMultiplier: 0,
        breath: 0,
        keyRoot: 0,
        volumeOverride: 0,
        chanPan: 0,
        tonePan: 0,
    }
}

/**
 * This reimplements "Component Sound Library" -- an SPU driver found in later
 * PS1 games (circa 1999). It was ported to the "tentative" libspu2 library to
 * run on PS2 as an IOP module. It provides a lightweight MIDI sequencer ticked
 * every frame, so events become temporally aliased in the original
 * implementation. This implementation uses predictive Web Audio scheduling
 * rather than a strictly timer-based approach, so it's more faithful to the
 * MIDI data rather than the original sequencer.
 *
 * Component Sound Library discussion:
 * https://hcs64.com/mboard/forum.php?showthread=63999
 *
 * .SQ .HD .BD formats documented at:
 * https://problemkaputt.de/psxspx-cdrom-file-audio-other-formats.htm
 */
export default class OsdSnd extends SPU2 {
    static readonly MAX_VOICES = 24;
    private seqStates: Set<SequenceState> = new Set();
    private voiceStates: VoiceState[] = nArray(OsdSnd.MAX_VOICES, makeVoiceState);
    private numActiveVoices = 0;

    public constructor() {
        super();
    }

    public precacheSamples(hd: HD) {
        for (let i = 0; i < hd.instruments.length; ++i) {
            const inst = hd.instruments[i];
            if (inst !== null) {
                for (let t = 0; t < inst.tones.length; ++t) {
                    const tone = inst.tones[t];
                    this.getSampleBuffer({ buffer: hd.sampleData, offset: tone.offset * 8 });
                }
            }
        }
    }

    public addSQ(hd: HD, sq: SQ): SequenceState {
        const seq = makeSequenceState();
        this.seqStates.add(seq);

        seq.playing = false;
        seq.sq = sq;
        seq.hd = hd;
        seq.midiCur = 0;
        seq.midiStatus = sq.midiData[0];
        seq.midiOp1 = sq.midiData[1];
        seq.midiOp2 = sq.midiData[2];
        seq.lastMidiStatus = seq.midiStatus;
        seq.ticksPerQuarterNote = sq.ticksPerQuarterNote;
        OsdSnd.setTempo(seq, sq.tempo);
        for (let i = 0; i < NUM_MIDI_CHANNELS; ++i) {
            seq.channels[i] = cloneSQChannel(sq.channels[i]);
        }

        seq.startTime = null;
        seq.msgTime = 0;

        return seq;
    }

    public removeSQ(seq: SequenceState) {
        assert(this.seqStates.has(seq));
        this.stopSeq(seq);
        this.seqStates.delete(seq);
    }

    public startSeq(seq: SequenceState) {
        assert(this.seqStates.has(seq));
        seq.playing = true;
    }

    public stopSeq(seq: SequenceState) {
        assert(this.seqStates.has(seq));
        seq.playing = false;
        // TODO: Actually stop voices
    }

    private static readMidiMessage(seq: SequenceState) {
        const midiData = assertExists(seq.sq).midiData;
        const status = midiData[seq.midiCur];
        if ((status & 0x80) === 0) {
            seq.midiCur -= 1;
            seq.midiStatus = seq.lastMidiStatus;
        } else {
            seq.lastMidiStatus = seq.midiStatus;
            seq.midiStatus = status;
        }
        seq.midiOp1 = midiData[seq.midiCur + 1];
        seq.midiOp2 = midiData[seq.midiCur + 2];
    }

    private static readMidiDeltaTime(seq: SequenceState) {
        const midiData = assertExists(seq.sq).midiData;
        let timeByte;
        let deltaTimeTicks = 0;
        do {
            timeByte = midiData[seq.midiCur];
            deltaTimeTicks = (deltaTimeTicks << 7) | (timeByte & 0x7f);
            seq.midiCur += 1;
        } while (timeByte & 0x80);
        if (seq.tempo !== 0) {
            const deltaTimeSec = deltaTimeTicks * seq.secondsPerTick;
            seq.msgTime += deltaTimeSec;
        }
    }

    private static setupChannelContext(seq: SequenceState): boolean {
        const hd = assertExists(seq.hd);
        const channelIdx = seq.midiStatus & 0xf;
        const channel = seq.channels[channelIdx];
        const instIdx = channel.program;
        seq.curChannel = channel;
        seq.curInstrument = instIdx < hd.instruments.length ? hd.instruments[instIdx] : null;
        if (seq.midiStatus < 0xa0 && seq.curInstrument === null) {
            OsdSnd.warnSeq(seq, ` Instrument ${instIdx} is not present`)
            seq.midiCur += 3;
            return false;
        }
        return true;
    }

    private static isVoiceManagedByMessage(seq: SequenceState, vox: VoiceState): boolean {
        return vox.allocated
            && vox.seq === seq
            && vox.midiChannel === (seq.midiStatus & 0xf)
            && vox.hd === seq.hd;
    }

    private static calcEffectiveVoiceVolume(vox: VoiceState, right: boolean): number {
        const panVolume = right ? vox.panRightVolume : vox.panLeftVolume;
        let volume = (((vox.masterVolume * vox.chanVolume * vox.instVolume * vox.velVolume)
            >> 14) * vox.toneVolume * panVolume) >> 14;
        if (vox.volumeOverride !== 0) {
            volume = (volume >> 7) | (vox.volumeOverride << 8);
        }
        return volume;
    }

    private static combinePans(pan1: number, pan2: number): number {
        return clamp(pan1 + pan2 - 64, 0, 127);
    }

    static readonly PAN_LUT = [
        0x80, 0x00,
        0x80, 0x08,
        0x80, 0x10,
        0x80, 0x18,
        0x80, 0x20,
        0x80, 0x28,
        0x80, 0x30,
        0x80, 0x38,
        0x80, 0x40,
        0x80, 0x48,
        0x80, 0x50,
        0x80, 0x58,
        0x80, 0x60,
        0x80, 0x68,
        0x80, 0x70,
        0x78, 0x78,
        0x78, 0x78,
        0x70, 0x80,
        0x68, 0x80,
        0x60, 0x80,
        0x58, 0x80,
        0x50, 0x80,
        0x48, 0x80,
        0x40, 0x80,
        0x38, 0x80,
        0x30, 0x80,
        0x28, 0x80,
        0x20, 0x80,
        0x18, 0x80,
        0x10, 0x80,
        0x08, 0x80,
        0x00, 0x80,
    ];

    static readonly PITCH_LUT = [
        0x078D, 0x0793, 0x079B, 0x07A2, 0x07A9, 0x07B1, 0x07B7, 0x07BE, 0x07C5, 0x07CC, 0x07D4, 0x07DB, 0x07E2, 0x07EA, 0x07F1, 0x07F8,
        0x0800, 0x0807, 0x080E, 0x0816, 0x081D, 0x0825, 0x082C, 0x0834, 0x083C, 0x0843, 0x084B, 0x0852, 0x085A, 0x0862, 0x086A, 0x0871,
        0x0879, 0x0881, 0x0889, 0x0891, 0x0899, 0x08A1, 0x08A9, 0x08B1, 0x08B9, 0x08C1, 0x08C9, 0x08D1, 0x08D9, 0x08E2, 0x08EA, 0x08F2,
        0x08FA, 0x0903, 0x090B, 0x0913, 0x091C, 0x0924, 0x092D, 0x0935, 0x093E, 0x0946, 0x094F, 0x0957, 0x0960, 0x0969, 0x0972, 0x097A,
        0x0938, 0x098C, 0x0995, 0x099E, 0x09A6, 0x09AF, 0x09B8, 0x09C1, 0x09CA, 0x09D3, 0x09DD, 0x09E6, 0x09EF, 0x09F8, 0x0A01, 0x0A0B,
        0x0A14, 0x0A1D, 0x0A27, 0x0A30, 0x0A39, 0x0A43, 0x0A4C, 0x0A56, 0x0A5F, 0x0A69, 0x0A73, 0x0A7C, 0x0A86, 0x0A90, 0x0A9A, 0x0AA3,
        0x0AAD, 0x0AB7, 0x0AC1, 0x0ACB, 0x0AD5, 0x0ADF, 0x0AE9, 0x0AF3, 0x0AFD, 0x0B08, 0x0B12, 0x0B1C, 0x0B26, 0x0B31, 0x0B3B, 0x0B45,
        0x0B50, 0x0B5A, 0x0B65, 0x0B6F, 0x0B7A, 0x0B85, 0x0B8F, 0x0B9A, 0x0BA5, 0x0BB0, 0x0BBA, 0x0BC5, 0x0BD0, 0x0BDB, 0x0BE6, 0x0BF1,
        0x0BFC, 0x0C07, 0x0C12, 0x0C1E, 0x0C29, 0x0C34, 0x0C3F, 0x0C4B, 0x0C56, 0x0C61, 0x0C6D, 0x0C78, 0x0C84, 0x0C90, 0x0C9B, 0x0CA7,
        0x0CB3, 0x0CBE, 0x0CCA, 0x0CD6, 0x0CE2, 0x0CEE, 0x0CFA, 0x0D06, 0x0D12, 0x0D1E, 0x0D2A, 0x0D36, 0x0D43, 0x0D4F, 0x0D5B, 0x0D68,
        0x0D74, 0x0D80, 0x0D8D, 0x0D99, 0x0DA6, 0x0DB3, 0x0DBF, 0x0DCC, 0x0DD9, 0x0DE6, 0x0DF3, 0x0E00, 0x0D0C, 0x0E1A, 0x0E27, 0x0E34,
        0x0E41, 0x0E4E, 0x0E5B, 0x0E69, 0x0E76, 0x0E83, 0x0E91, 0x0E9E, 0x0EAC, 0x0EB9, 0x0EC7, 0x0ED5, 0x0EE2, 0x0EF0, 0x0EFE, 0x0F0C,
        0x0F1A, 0x0F28, 0x0F36, 0x0F44, 0x0F52, 0x0F60, 0x0F6F, 0x0F7D, 0x0F8B, 0x0F9A, 0x0FA8, 0x0FB6, 0x0FC5, 0x0FD4, 0x0FE2, 0x0FF1,
        0x1000, 0x100E, 0x101D, 0x102C, 0x103B, 0x104A, 0x1059, 0x1068, 0x1078, 0x1087, 0x1096, 0x10A5, 0x10B5, 0x10C4, 0x10D4, 0x10E3,
        0x10F3, 0x1103, 0x1113, 0x1122, 0x1132, 0x1142, 0x1152, 0x1162, 0x1172, 0x1182, 0x1193, 0x11A3, 0x11B3, 0x11C4, 0x11D4, 0x11E5,
        0x11F5, 0x1206, 0x1216, 0x1227, 0x1238, 0x1249, 0x125A, 0x126B, 0x127C, 0x128D, 0x129E, 0x12AF, 0x12C1, 0x12D2, 0x12E3, 0x12F5,
        0x1306, 0x1318, 0x132A, 0x133C, 0x134D, 0x135F, 0x1371, 0x1383, 0x1395, 0x13A7, 0x13BA, 0x13CC, 0x13DE, 0x13F1, 0x1403, 0x1416,
        0x1428, 0x143B, 0x144E, 0x1460, 0x1473, 0x1486, 0x1499, 0x14AC, 0x14BF, 0x14D3, 0x14E6, 0x14F9, 0x150D, 0x1520, 0x1534, 0x1547,
        0x155B, 0x156F, 0x1583, 0x1597, 0x15AB, 0x15BF, 0x15D3, 0x15E7, 0x15FB, 0x1610, 0x1624, 0x1638, 0x164D, 0x1662, 0x1676, 0x168B,
        0x16A0, 0x16B5, 0x16CA, 0x16DF, 0x16F4, 0x170A, 0x171F, 0x1734, 0x174A, 0x175F, 0x1775, 0x178B, 0x17A1, 0x17B6, 0x17CC, 0x17E2,
        0x17F9, 0x180F, 0x1825, 0x183B, 0x1852, 0x1868, 0x187F, 0x1896, 0x18AC, 0x18C3, 0x18DA, 0x18F1, 0x1908, 0x191F, 0x1937, 0x194E,
        0x1965, 0x197D, 0x1995, 0x19AC, 0x19C4, 0x19DC, 0x19F4, 0x1A0C, 0x1A24, 0x1A3C, 0x1A55, 0x1A6D, 0x1A85, 0x1A9E, 0x1AB7, 0x1ACF,
        0x1AE8, 0x1B01, 0x1B1A, 0x1B33, 0x1B4C, 0x1B66, 0x1B7F, 0x1B98, 0x1BB2, 0x1BCC, 0x1BE5, 0x1BFF, 0x1C19, 0x1C33, 0x1C4D, 0x1C67,
        0x1C82, 0x1C9C, 0x1CB7, 0x1CD1, 0x1CEC, 0x1D07, 0x1D22, 0x1D3D, 0x1D58, 0x1D73, 0x1D8E, 0x1DA9, 0x1DC5, 0x1DE0, 0x1DFC, 0x1E18,
        0x1E34, 0x1E50, 0x1E6C, 0x1E88, 0x1EA4, 0x1EC1, 0x1EDD, 0x1EFA, 0x1F16, 0x1F33, 0x1F50, 0x1F6D, 0x1F8A, 0x1FA7, 0x1FC5, 0x1FE2,
        0x2000, 0x201D, 0x203B, 0x2059, 0x2077, 0x2095, 0x20B3, 0x20D1, 0x20F0, 0x210E, 0x212D, 0x214B, 0x216A, 0x2189, 0x21A8, 0x21C7,
        0x21E7, 0x2206, 0x2226, 0x2245, 0x2265, 0x2285, 0x22A5, 0x22C5, 0x22E5, 0x2305, 0x2326, 0x2346, 0x2367, 0x2388, 0x23A9, 0x23CA,
        0x23EB, 0x240C, 0x242D, 0x244F, 0x2470, 0x2492, 0x24B4, 0x24D6, 0x24F8, 0x251A, 0x253D, 0x255F, 0x2583, 0x25A5, 0x25C7, 0x25EA,
        0x260E, 0x2631, 0x2654, 0x2678, 0x269B, 0x26BF, 0x26E3, 0x2707, 0x272B, 0x274F, 0x2774, 0x2798, 0x27BD, 0x27E2, 0x2807, 0x282C,
        0x2851, 0x2876, 0x289C, 0x28C1, 0x28E7, 0x290D, 0x2933, 0x2959, 0x297F, 0x29A6, 0x29CC, 0x29F3, 0x2A1A, 0x2A41, 0x2A68, 0x2A8F,
        0x2AB7, 0x2ADE, 0x2B06, 0x2B2E, 0x2B56, 0x2B7E, 0x2BA6, 0x2BCE, 0x2BF7, 0x2C20, 0x2C49, 0x2C72, 0x2C9B, 0x2CC4, 0x2CED, 0x2D17,
        0x2D41, 0x2D6B, 0x2D95, 0x2DBF, 0x2DE9, 0x2E14, 0x2E3E, 0x2E69, 0x2E94, 0x2EBF, 0x2EEB, 0x2F16, 0x2F42, 0x2F6D, 0x2F99, 0x2FC5,
        0x2FF2, 0x301E, 0x304B, 0x3077, 0x30A4, 0x30D1, 0x30FE, 0x312C, 0x3159, 0x3187, 0x31B5, 0x31E3, 0x3211, 0x323F, 0x326E, 0x329D,
        0x32CC, 0x32FB, 0x332A, 0x3359, 0x3389, 0x33B8, 0x33E8, 0x3418, 0x3449, 0x3479, 0x34AA, 0x34DA, 0x350B, 0x353C, 0x356E, 0x359F,
        0x35D1, 0x3603, 0x3635, 0x3667, 0x3699, 0x36CC, 0x36FF, 0x3731, 0x3765, 0x3798, 0x37CB, 0x37FF, 0x3833, 0x3867, 0x389B, 0x38CF,
        0x3904, 0x3939, 0x396E, 0x39A3, 0x39D8, 0x3A0E, 0x3A44, 0x3A7A, 0x3AB0, 0x3AE6, 0x3B1D, 0x3B53, 0x3B8A, 0x3BC1, 0x3BF9, 0x3C30,
        0x3C68, 0x3CA0, 0x3CD8, 0x3D10, 0x3D49, 0x3D82, 0x3DBB, 0x3DF4, 0x3E2D, 0x3E67, 0x3EA1, 0x3EDB, 0x3F15, 0x3F4F, 0x3F8A, 0x3FC5,
        0x4000, 0x403B, 0x4076, 0x40B2, 0x40EE, 0x412A, 0x4166, 0x41A3, 0x41E0, 0x421D, 0x425A, 0x4297, 0x42D5, 0x4313, 0x4351, 0x438F,
    ];

    protected static calcEffectiveVoicePitch(keyRoot: number, midiNote: number, toneBend: number, chanBend: number, bendMultiplier: number): number {
        let pitch;
        if (midiNote < keyRoot) {
            const noteDelta = keyRoot - midiNote;
            const lutIndex = (12 - noteDelta % 12) * 16 +
                ((((chanBend - 64) * (bendMultiplier & 0xffff)) / 4) >>> 0) +
                208 + toneBend;
            pitch = OsdSnd.PITCH_LUT[lutIndex] >> (((noteDelta / 12) >>> 0) + 1);
        } else {
            const noteDelta = midiNote - keyRoot;
            const lutIndex = noteDelta % 12 * 16 +
                ((((chanBend - 64) * (bendMultiplier & 0xffff)) / 4) >>> 0) +
                208 + toneBend;
            pitch = OsdSnd.PITCH_LUT[lutIndex] << ((noteDelta / 12) >>> 0);
        }

        // A hack present in the original osdsnd to handle SPU2's migration to 48kHz.
        // Ostensibly the original samples were authored for 44.1kHz playback (ala PS1 SPU),
        // this globally slows them down to compensate.
        return ((pitch * 44100 / 48000) >>> 0) & 0xffff;
    }

    private static isToneCorrectForNote(inst: HDInstrument, toneIdx: number, note: number): boolean {
        if (inst.sfx) {
            return true;
        }
        const tone = inst.tones[toneIdx];
        return note >= tone.noteMin && note <= tone.noteMax;
    }

    static logFormat(seq: SequenceState, msg: any): string {
        return `[t:${seq.msgTime}][o:${seq.midiCur}][c:${seq.midiStatus & 0xf}]${msg}`;
    }

    static debugSeq(seq: SequenceState, msg: any): void {
        if (IS_DEVELOPMENT) {
            console.debug(OsdSnd.logFormat(seq, msg));
        }
    }

    static warnSeq(seq: SequenceState, msg: any): void {
        console.warn(OsdSnd.logFormat(seq, msg));
    }

    private findFreeVoice(): number {
        for (let i = 0; i < OsdSnd.MAX_VOICES; ++i) {
            const vox = this.voiceStates[i];
            if (!vox.allocated && vox.midiNote === 0) {
                return i;
            }
        }

        let minAgeCounter = OsdSnd.MAX_VOICES;
        let minVoiceIndex = 0;
        for (let i = 0; i < OsdSnd.MAX_VOICES; ++i) {
            const vox = this.voiceStates[i];
            if (vox.keyOff && vox.lruAgeCountdown < minAgeCounter) {
                minAgeCounter = vox.lruAgeCountdown;
                minVoiceIndex = i;
            }
        }

        if (minAgeCounter === OsdSnd.MAX_VOICES) {
            return -1;
        }

        for (let i = 0; i < OsdSnd.MAX_VOICES; ++i) {
            const vox = this.voiceStates[i];
            if (minAgeCounter < vox.lruAgeCountdown) {
                vox.lruAgeCountdown -= 1;
            }
        }

        return minVoiceIndex;
    }

    private onMidiModWheel(seq: SequenceState) {
        OsdSnd.debugSeq(seq, `[ModWheel] Val: ${seq.midiOp2}`);
        const channel = assertExists(seq.curChannel);
        channel.modulation = seq.midiOp2;
        for (let v = 0; v < this.voiceStates.length; ++v) {
            const vox = this.voiceStates[v];
            if (OsdSnd.isVoiceManagedByMessage(seq, vox)) {
                vox.modulation = seq.midiOp2;
                vox.enableModulation = true;
            }
        }
        seq.midiCur += 3;
    }

    private onMidiBreathControl(seq: SequenceState) {
        const breathDivisor = 60 - ((seq.midiOp2 * 58 / 127) >>> 0);
        assert(breathDivisor !== 0);
        const breath = 240 / breathDivisor >>> 0;
        OsdSnd.debugSeq(seq, `[BreathControl] Val: ${seq.midiOp2} -> ${breath}`);
        const channel = assertExists(seq.curChannel);
        channel.breath = breath;
        for (let v = 0; v < this.voiceStates.length; ++v) {
            const vox = this.voiceStates[v];
            if (OsdSnd.isVoiceManagedByMessage(seq, vox)) {
                vox.breath = breath;
            }
        }
        seq.midiCur += 3;
    }

    private onMidiDataEntry(seq: SequenceState) {
        OsdSnd.debugSeq(seq, `[DataEntry] Val: ${seq.midiOp2}`);
        if (!seq.preventDataEntryNRPNLSBUpdate) {
            // Loop count
            if (seq.midiOp2 === 0x7f) {
                OsdSnd.debugSeq(seq, `[DataEntry]   Looping infinitely`);
            } else {
                OsdSnd.debugSeq(seq, `[DataEntry]   Looping ${seq.midiOp2} times`);
            }
            seq.loopCount = seq.midiOp2;
        }
        seq.midiCur += 3;
    }

    private onMidiVolume(seq: SequenceState) {
        OsdSnd.debugSeq(seq, `[Volume] Vol: ${seq.midiOp2}`);
        const channel = assertExists(seq.curChannel);
        channel.volume = seq.midiOp2;
        for (let v = 0; v < this.voiceStates.length; ++v) {
            const vox = this.voiceStates[v];
            if (OsdSnd.isVoiceManagedByMessage(seq, vox) && !vox.keyOff) {
                vox.chanVolume = seq.midiOp2;
                const attr: SpuVoiceAttr = {
                    voiceMask: (1 << v),
                    volume: {
                        left: OsdSnd.calcEffectiveVoiceVolume(vox, false),
                        right: OsdSnd.calcEffectiveVoiceVolume(vox, true),
                    }
                };
                this.setVoiceAttr(seq.msgTime, attr);
            }
        }
        seq.midiCur += 3;
    }

    private onMidiPan(seq: SequenceState) {
        OsdSnd.debugSeq(seq, `[Pan] Pan: ${seq.midiOp2}`);
        const channel = assertExists(seq.curChannel);
        channel.pan = seq.midiOp2;
        for (let v = 0; v < this.voiceStates.length; ++v) {
            const vox = this.voiceStates[v];
            if (OsdSnd.isVoiceManagedByMessage(seq, vox) && !vox.keyOff) {
                vox.chanPan = seq.midiOp2;
                const pan = (OsdSnd.combinePans(vox.chanPan, vox.tonePan) / 4) >>> 0;
                vox.panLeftVolume = OsdSnd.PAN_LUT[pan * 2];
                vox.panRightVolume = OsdSnd.PAN_LUT[pan * 2 + 1];
                const attr: SpuVoiceAttr = {
                    voiceMask: (1 << v),
                    volume: {
                        left: OsdSnd.calcEffectiveVoiceVolume(vox, false),
                        right: OsdSnd.calcEffectiveVoiceVolume(vox, true),
                    }
                };
                this.setVoiceAttr(seq.msgTime, attr);
            }
        }
        seq.midiCur += 3;
    }

    private onMidiDamperPedal(seq: SequenceState) {
        OsdSnd.debugSeq(seq, `[DamperPedal]`);
        seq.midiCur += 3;
    }

    private onMidiPortamento(seq: SequenceState) {
        OsdSnd.debugSeq(seq, `[Portamento]`);
        // Do nothing???
    }

    private onMidiDataIncrement(seq: SequenceState) {
        OsdSnd.debugSeq(seq, `[DataIncrement]`);
        // Do nothing???
    }

    private onMidiNRPNLSB(seq: SequenceState) {
        OsdSnd.debugSeq(seq, `[NRPNLSB] Val: ${seq.midiOp2}`);
        if (!seq.preventNRPNLSBUpdate) {
            // Loop count
            if (seq.midiOp2 === 0x7f) {
                OsdSnd.debugSeq(seq, `[NRPNLSB]   Looping infinitely`);
            } else {
                OsdSnd.debugSeq(seq, `[NRPNLSB]   Looping ${seq.midiOp2} times`);
            }
            seq.loopCount = seq.midiOp2;
            seq.preventDataEntryNRPNLSBUpdate = false;
        }
        seq.midiCur += 3;
    }

    private onMidiNRPNMSB(seq: SequenceState) {
        OsdSnd.debugSeq(seq, `[NRPNMSB] Val: ${seq.midiOp2}`);
        if (seq.midiOp2 === 0x14) {
            // Loop start
            OsdSnd.debugSeq(seq, `[NRPNMSB]   Loop start`);
            seq.midiStatusAtLoopStart = seq.midiStatus;
            seq.midiCurAtLoopStart = seq.midiCur;
            seq.preventNRPNLSBUpdate = false;
            seq.preventDataEntryNRPNLSBUpdate = false;
        } else if (seq.midiOp2 === 0x1e) {
            // Loop end
            if (seq.loopCount === 0x7f) {
                // Infinite loop
                OsdSnd.debugSeq(seq, `[NRPNMSB]   Loop end (infinite)`);
                seq.loopThisTick = true;
            } else if (seq.loopCounter < seq.loopCount) {
                // Counting to finite loop
                OsdSnd.debugSeq(seq, `[NRPNMSB]   Loop end (${seq.loopCounter}/${seq.loopCount})`);
                seq.loopCounter += 1;
                seq.loopThisTick = true;
            } else {
                // Done counting to finite loop, continue
                OsdSnd.debugSeq(seq, `[NRPNMSB]   Loop end (continuing)`);
                seq.loopCounter = 0;
                seq.midiCurAtLoopStart = 0;
                seq.loopThisTick = false;
            }
            seq.preventNRPNLSBUpdate = false;
        }
        seq.midiCur += 3;
    }

    private onMidiNoteOn(seq: SequenceState) {
        OsdSnd.debugSeq(seq, `[NoteOn] Note: ${seq.midiOp1}, Vel: ${seq.midiOp2}`);
        if (seq.midiOp2 === 0) {
            this.onMidiNoteOff(seq);
            return;
        }
        const inst = assertExists(seq.curInstrument);
        let minTone;
        let maxTone;
        let singleTone;
        if (inst.sfx) {
            minTone = seq.midiOp1 - inst.sfxStartingNote;
            maxTone = minTone + 1;
            singleTone = false;
        } else {
            minTone = 0;
            maxTone = inst.tones.length;
            singleTone = !inst.multiToneFlag;
        }
        for (let t = minTone; t < maxTone; ++t) {
            if (!OsdSnd.isToneCorrectForNote(inst, t, seq.midiOp1)) {
                continue;
            }
            const voxIndex = this.findFreeVoice();
            if (voxIndex === -1) {
                OsdSnd.warnSeq(seq, `[NoteOn]   Out of voices`);
                break;
            }
            OsdSnd.debugSeq(seq, `[NoteOn]   Allocated voice:${voxIndex} inst:${inst.index} tone:${t}`);
            const tone = inst.tones[t];
            const vox = this.voiceStates[voxIndex];
            if ((tone.toneFlags & 1) === 0) {
                vox.keyOff = true;
                vox.allowsSustain = false;
            } else {
                vox.keyOff = false;
                vox.allowsSustain = true;
            }
            vox.allocated = true;
            vox.midiNote = seq.midiOp1;
            vox.midiChannel = seq.midiStatus & 0xf;
            vox.seq = seq;
            vox.lruAgeCountdown = this.numActiveVoices;
            vox.toneIndex = t;
            vox.breathAccumulator = 0;
            const hd = assertExists(seq.hd);
            vox.hd = hd;
            vox.instVolume = inst.volume;
            const velocities = hd.velocities;
            vox.velVolume = velocities.volumes[seq.midiOp2];
            vox.toneVolume = tone.vol;
            const channel = assertExists(seq.curChannel);
            const pan = (OsdSnd.combinePans(channel.pan, tone.pan) / 4) >>> 0;
            vox.panLeftVolume = OsdSnd.PAN_LUT[pan * 2];
            vox.panRightVolume = OsdSnd.PAN_LUT[pan * 2 + 1];
            vox.chanVolume = channel.volume;
            const sq = assertExists(seq.sq);
            vox.masterVolume = sq.masterVolume;
            let tonePitchBend = tone.bendSixteenths;
            if (tonePitchBend & 0x80) {
                tonePitchBend = tonePitchBend << 24 >> 24;
            }
            vox.tonePitchBend = tonePitchBend;
            vox.chanPitchBend = channel.pitchBend;
            vox.pitchBendMultiplier = tone.pitchBendMultiplier;
            vox.breath = channel.breath;
            vox.keyRoot = tone.keyRoot;
            vox.volumeOverride = tone.volOverride;
            vox.chanPan = channel.pan;
            vox.tonePan = tone.pan;
            if ((tone.toneFlags & 0x20) === 0 || channel.modulation === 0) {
                vox.enableModulation = false;
                vox.modulation = 0;
            } else {
                vox.breathModulation = tone.breathControlIndex;
                vox.enableModulation = true;
                vox.modulation = channel.modulation;
            }
            const attr: SpuVoiceAttr = {
                voiceMask: (1 << voxIndex),
                aMode: SpuRateMode.SPU_VOICE_LINEARIncN,
                sMode: SpuRateMode.SPU_VOICE_LINEARIncN,
                rMode: SpuRateMode.SPU_VOICE_LINEARDecN,
                pitch: OsdSnd.calcEffectiveVoicePitch(tone.keyRoot, seq.midiOp1, tonePitchBend, channel.pitchBend, tone.pitchBendMultiplier),
                volume: {
                    left: OsdSnd.calcEffectiveVoiceVolume(vox, false),
                    right: OsdSnd.calcEffectiveVoiceVolume(vox, true),
                },
                addr: { buffer: hd.sampleData, offset: tone.offset * 8 },
                adsr1: tone.adsr1,
                adsr2: tone.adsr2,
            };
            this.setVoiceAttr(seq.msgTime, attr);
            const reverb = (tone.toneFlags & 0x80) !== 0;
            // TODO: reverb
            this.setKeyOn(seq.msgTime, 1 << voxIndex);
            this.numActiveVoices = Math.min(OsdSnd.MAX_VOICES, this.numActiveVoices + 1);
            if (singleTone) {
                break;
            }
        }
        seq.midiCur += 3;
    }

    private onMidiNoteOff(seq: SequenceState) {
        OsdSnd.debugSeq(seq, `[NoteOff] Note: ${seq.midiOp1}, Vel: ${seq.midiOp2}`);
        for (let v = 0; v < this.voiceStates.length; ++v) {
            const vox = this.voiceStates[v];
            if (OsdSnd.isVoiceManagedByMessage(seq, vox) && vox.midiNote === seq.midiOp1) {
                vox.keyOff = true;
                this.setKeyOff(seq.msgTime, 1 << v);
            }
        }
        seq.midiCur += 3;
    }

    private onMidiPitchBend(seq: SequenceState) {
        OsdSnd.debugSeq(seq, `[PitchBend] Pitch: ${seq.midiOp1}`);
        const channel = assertExists(seq.curChannel);
        channel.pitchBend = seq.midiOp1;
        for (let v = 0; v < this.voiceStates.length; ++v) {
            const vox = this.voiceStates[v];
            if (OsdSnd.isVoiceManagedByMessage(seq, vox)) {
                const inst = assertExists(seq.curInstrument);
                const tone = inst.tones[vox.toneIndex];
                const attr: SpuVoiceAttr = {
                    voiceMask: (1 << v),
                    pitch: OsdSnd.calcEffectiveVoicePitch(vox.keyRoot, vox.midiNote,
                        vox.tonePitchBend, channel.pitchBend, tone.pitchBendMultiplier),
                };
                this.setVoiceAttr(seq.msgTime, attr);
                vox.chanPitchBend = seq.midiOp1;
            }
        }
        seq.midiCur += 2;
    }

    private onMidiProgramEvent(seq: SequenceState) {
        const hd = assertExists(seq.hd);
        const instIdx = seq.midiOp1;
        const inst = instIdx < hd.instruments.length ? hd.instruments[instIdx] : null;
        OsdSnd.debugSeq(seq, `[ProgramEvent] Inst ${instIdx} (${inst === null ? "not-exists" : "exists"})`);
        const channel = assertExists(seq.curChannel);
        channel.program = seq.midiOp1;
        channel.pitchBend = 64;
        channel.priority = 64;
        seq.midiCur += 2;
    }

    private onMidiEndOfTrack(seq: SequenceState) {
        OsdSnd.debugSeq(seq, `[EndOfTrack]`);
        seq.midiCur = 0;
        seq.playing = false;
        for (let v = 0; v < this.voiceStates.length; ++v) {
            const vox = this.voiceStates[v];
            if (vox.seq == seq) {
                vox.enableModulation = false;
                vox.chanPitchBend = 64;
            }
        }
        seq.lastMidiStatus = seq.midiStatus;
    }

    private static setTempo(seq: SequenceState, tempo: number) {
        seq.tempo = tempo;
        seq.secondsPerTick = 60 / (seq.ticksPerQuarterNote * tempo);
    }

    private onMidiTempoChange(seq: SequenceState) {
        const midiData = assertExists(seq.sq).midiData;
        const tempo = midiData[seq.midiCur + 2] | (midiData[seq.midiCur + 3] << 8);
        OsdSnd.debugSeq(seq, `[TempoChange] Tempo: ${tempo}`);
        OsdSnd.setTempo(seq, tempo);
        seq.midiCur += 4;
    }

    protected override schedule(from: number, to: number): void {
        this.seqStates.forEach((seq) => {
            if (!seq.playing) {
                return;
            }

            if (seq.startTime === null) {
                seq.startTime = from;
                seq.msgTime = from;
            }

            while (seq.msgTime < to) {
                const msgTime = seq.msgTime;

                OsdSnd.readMidiMessage(seq);
                if (OsdSnd.setupChannelContext(seq)) {
                    switch (seq.midiStatus & 0xf0) {
                        case 0xb0:
                            // Controller event
                            switch (seq.midiOp1) {
                                case 1:
                                    this.onMidiModWheel(seq);
                                    break;
                                case 2:
                                    this.onMidiBreathControl(seq);
                                    break;
                                case 6:
                                    this.onMidiDataEntry(seq);
                                    break;
                                case 7:
                                    this.onMidiVolume(seq);
                                    break;
                                case 10:
                                    this.onMidiPan(seq);
                                    break;
                                case 64:
                                    this.onMidiDamperPedal(seq);
                                    break;
                                case 65:
                                    this.onMidiPortamento(seq);
                                    break;
                                case 96:
                                    this.onMidiDataIncrement(seq);
                                    break;
                                case 98:
                                    this.onMidiNRPNLSB(seq);
                                    break;
                                case 99:
                                    this.onMidiNRPNMSB(seq);
                                    break;
                                default:
                                    break;
                            }
                            break;
                        case 0x90:
                            this.onMidiNoteOn(seq);
                            break;
                        case 0x80:
                            this.onMidiNoteOff(seq);
                            break;
                        case 0xe0:
                            this.onMidiPitchBend(seq);
                            break;
                        case 0xc0:
                            this.onMidiProgramEvent(seq);
                            break;
                        case 0xf0:
                            // Meta event
                            switch (seq.midiOp1) {
                                case 0x2f:
                                    this.onMidiEndOfTrack(seq);
                                    break;
                                case 0x51:
                                    this.onMidiTempoChange(seq);
                                    break;
                                default:
                                    break;
                            }
                            break;
                        default:
                            break;
                    }
                }

                OsdSnd.readMidiDeltaTime(seq);

                if (seq.loopThisTick) {
                    // Do loop
                    seq.midiStatus = seq.midiStatusAtLoopStart;
                    seq.lastMidiStatus = seq.midiStatusAtLoopStart;
                    seq.midiCur = seq.midiCurAtLoopStart;
                    seq.loopThisTick = false;
                    seq.playing = true;
                    seq.msgTime = msgTime;
                }
            }
        });
    }
}
