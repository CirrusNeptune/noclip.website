import BaseDSP from "./BaseDSP";
import { assert, assertExists, nArray } from "../../util";
import { IS_DEVELOPMENT } from "../../BuildVersion";

/**
 * volMode === SPU_VOICE_DIRECT: [-0x4000,0x3fff]
 * Negative values are reversed phase.
 *
 * All others define a sweep rate: [0x00,0x7f]
 * Higher values are exponentially slower.
 * Lowest value reaches 0-32767 as quickly as possible (about three samples).
 * Highest value prevents that ADSR phase ticking entirely (constant level).
 */
export interface SpuVolume {

    left?: number;
    right?: number;
}

/**
 * Combines Sweep/ADSR function mode (linear/exponential) direction and phase
 * inversion in one enum (not actually representative of a single register).
 */
export enum SpuRateMode {
    SPU_VOICE_DIRECT,
    // N/R: Normal/Reversed Phase.
    SPU_VOICE_LINEARIncN,
    SPU_VOICE_LINEARIncR,
    SPU_VOICE_LINEARDecN,
    SPU_VOICE_LINEARDecR,
    SPU_VOICE_EXPIncN,
    SPU_VOICE_EXPIncR,
    SPU_VOICE_EXPDec
}

/**
 * Stereo pair of the SpuRateMode.
 */
export interface SpuVolumeRateMode {
    left?: SpuRateMode;
    right?: SpuRateMode;
}

/**
 * Sound buffer pointer alternative which permits sharing the buffer
 * asset reference and using it as a DecodedBuffer cache key.
 */
export interface SampleBufferAndOffset {
    buffer: Uint8Array;
    offset: number;
}

/**
 * "High-level" voice attribute register structure.
 * Supports partial register writes, retaining the prior value of undefined attrs.
 */
export interface SpuVoiceAttr {
    /**
     * Bitmask of voices to apply set attributes to.
     */
    voiceMask: number;

    /**
     * Direct volume or sweep rates of each channel.
     */
    volume?: SpuVolume;

    /**
     * Volume sweep mode.
     * When not SPU_VOICE_DIRECT, the volume parameter above is interpreted as
     * a sweep rate.
     */
    volMode?: SpuVolumeRateMode;

    /**
     * The current volume output level.
     * Writable in the original hardware, but the SPU library in osdsnd does not
     * permit actually setting it. This has little utility since it gets clobbered
     * by the hardware volume sweep generator. Kept for posterity.
     */
    volumeX?: SpuVolume;

    /**
     * Raw pitch register as 2.12 fixed-point multiple of 48kHz [0x00,0x3fff].
     * 0x800 === 24kHz
     * 0x1000 === 48kHz
     * 0x2000 === 96kHz
     */
    pitch?: number;

    /**
     * Alternative to setting raw pitch as interval of (note - sampleNote).
     * Upper 8 bits is the MIDI note number, lower 8 bits is 1/128 of a semitone.
     */
    note?: number;
    sampleNote?: number;

    /**
     * The current envelope (ADSR) output level.
     * Writable in the original hardware, but the SPU library in osdsnd does not
     * permit actually setting it. This has little utility since it gets clobbered
     * by the hardware envelope generator. Kept for posterity.
     */
    envx?: number;

    /**
     * Address of sample in sound buffer.
     */
    addr?: SampleBufferAndOffset;

    /**
     * Loop start address if not specified with flag 0x4 in the sample data.
     */
    loopAddr?: number;

    /**
     * Envelope rate modes
     */
    aMode?: SpuRateMode;
    sMode?: SpuRateMode;
    rMode?: SpuRateMode;

    /**
     * Envelope rates
     * Higher values are exponentially slower.
     * Lowest value reaches 0-32767 as quickly as possible (about three samples).
     * Highest value prevents that ADSR phase ticking entirely (constant level).
     */
    ar?: number; // [0x00,0x7f]
    dr?: number; // [0x00,0xf]
    sr?: number; // [0x00,0x7f]
    rr?: number; // [0x00,0x1f]
    sl?: number; // [0x00,0xf]

    /**
     * Raw ADSR registers (packs all 8 fields above)
     * https://psx-spx.consoledev.net/soundprocessingunitspu/#spu-volume-and-adsr-generator
     */
    adsr1?: number;
    adsr2?: number;
}

enum RateMode {
    Linear,
    Exponential
}

enum RateDirection {
    Increasing,
    Decreasing
}

/**
 * [Internal] Unpacked adsr1/adsr2.
 */
interface ADSRRegisters {
    ar: number; // Attack rate [0x00,0x7f]
    ar_m: RateMode; // Attack rate mode
    dr: number; // Decay rate [0x00,0xf]
    sr: number; // Sustain rate [0x00,0x7f]
    sl: number; // Sustain level [0x00,0xf]
    sr_s: RateDirection; // Sustain rate sign
    sr_m: RateMode; // Sustain rate mode
    rr: number; // Release rate [0x00,0x1f]
    rr_m: RateMode; // Release rate mode
}

/**
 * [Internal] Makes a default instant-on/instant-off ADSR configuration.
 */
function makeADSRRegisters(): ADSRRegisters {
    return {
        ar: 0,
        ar_m: RateMode.Linear,
        dr: 0xf,
        sr: 0x7f,
        sl: 0xf,
        sr_s: RateDirection.Decreasing,
        sr_m: RateMode.Linear,
        rr: 0,
        rr_m: RateMode.Linear,
    };
}

/**
 * [Internal] Structure to hold AudioNode references and register values for
 * deferred key-on.
 */
interface SPUVoice {
    index: number;
    sourceNode: AudioBufferSourceNode | null;
    adsrGainNode: GainNode;
    leftGainNode: GainNode;
    rightGainNode: GainNode;
    channelMergerNode: ChannelMergerNode;
    addr: SampleBufferAndOffset | null;
    pitch: number;
    adsr: ADSRRegisters;
}

/**
 * [Internal] Cacheable values from decoding SPU-ADPCM sample data.
 */
interface DecodedBuffer {
    audioBuffer: AudioBuffer;
    loop: boolean;
    loopStart: number;
    loopEnd: number;
}

/**
 * [Internal] Owns SPU-ADPCM data and caches decoded segments of audio.
 */
interface SampleBuffer {
    decodedBuffers: Map<number, DecodedBuffer>;
}

/**
 * [Internal] State structure for iteratively scheduling envelope automations.
 */
interface EnvelopeState {
    voice: SPUVoice; // Voice for debugging
    sample: number; // Sample index
    level: number; // Level as signed 16-bit integer
    complete: boolean; // Ticking complete (reached infinitely held constant)
    needsCancel: boolean; // Last automation was setTargetAtTime (issue cancel-and-hold before proceeding)
}

/**
 * Base implementation of SPU2 on top of Web Audio.
 *
 * Provides voice spawning / tracking as AudioNodes and ADPCM sample caching.
 *
 * Intended to be subclassed by a specific IOP driver reimplementation which
 * handles game messages and sequence scheduling, rather than used directly.
 */
export abstract class SPU2 extends BaseDSP {
    static readonly NUM_VOICES: number = 24;
    static readonly VOICE_SAMPLE_RATE: number = 48000;
    private voices: SPUVoice[] = [];
    private sampleBuffers: Map<Uint8Array, SampleBuffer> = new Map<Uint8Array, SampleBuffer>();

    private static spuLogFormat(voice: SPUVoice, msg: any): string {
        return `[v:${voice.index}]${msg}`;
    }

    private static debugVoice(voice: SPUVoice, msg: any): void {
        if (IS_DEVELOPMENT) {
            //console.debug(SPU2.spuLogFormat(voice, msg));
        }
    }

    private constructVoice(index: number): SPUVoice {
        const adsrGainNode = this.audioContext.createGain();
        adsrGainNode.gain.value = 0;
        const leftGainNode = this.audioContext.createGain();
        leftGainNode.gain.value = 1;
        const rightGainNode = this.audioContext.createGain();
        rightGainNode.gain.value = 1;

        adsrGainNode.connect(leftGainNode);
        adsrGainNode.connect(rightGainNode);

        const channelMergerNode = this.audioContext.createChannelMerger(2);
        leftGainNode.connect(channelMergerNode, 0, 0);
        rightGainNode.connect(channelMergerNode, 0, 1);
        channelMergerNode.connect(this.audioContext.destination);

        return {
            index,
            sourceNode: null,
            adsrGainNode,
            leftGainNode,
            rightGainNode,
            channelMergerNode,
            addr: null,
            pitch: 1.0,
            adsr: makeADSRRegisters()
        };
    }

    public override start() {
        super.start();
        this.voices = nArray(SPU2.NUM_VOICES, this.constructVoice.bind(this));
    }

    public override async stop(): Promise<void> {
        this.voices = [];
        return super.stop();
    }

    static readonly SPU_ADPCM_COEFS = [
        0.0,         0.0,
        0.9375,      0.0,
        1.796875,    -0.8125,
        1.53125,     -0.859375,
        1.90625,     -0.9375,
        0.46875,     -0.0,
        0.8984375,   -0.40625,
        0.765625,    -0.4296875,
        0.953125,    -0.46875,
        0.234375,    -0.0,
        0.44921875,  -0.203125,
        0.3828125,   -0.21484375,
        0.4765625,   -0.234375,
        0.5,         -0.9375,
        0.234375,    -0.9375,
        0.109375,    -0.9375,
    ];

    static readonly NUM_BLOCK_SAMPLES = 28;

    private decodeSample(data: Uint8Array, offset: number): DecodedBuffer {
        assert((offset % 16) === 0, "Offset must be a multiple of 16");
        assert((data.length % 16) === 0, "Data length must be a multiple of 16");
        assert(offset < data.length, "Offset must be within bounds of data");

        const startBlock = offset / 16 >>> 0;
        let endBlock = data.length / 16 >>> 0;
        let loopStartBlock = startBlock;
        let loop = false;

        for (let i = startBlock; i < endBlock; ++i) {
            const flags = data[i * 16 + 1];
            if (flags & 0x4) {
                // Set loop start address
                loopStartBlock = i;
            }
            if ((flags & 0x3) === 0x1) {
                // Oneshot end
                endBlock = i + 1;
                loop = false;
                break;
            } else if ((flags & 0x3) === 0x3) {
                // Loop end
                endBlock = i + 1;
                loop = true;
                break;
            }
        }

        const numFrames = (endBlock - startBlock) * SPU2.NUM_BLOCK_SAMPLES;
        const audioBuffer = this.audioContext.createBuffer(1, numFrames, SPU2.VOICE_SAMPLE_RATE);
        const channelData = audioBuffer.getChannelData(0);

        let h1 = 0;
        let h2 = 0;

        let sOut = 0;
        for (let i = startBlock; i < endBlock; ++i) {
            let coefIndex = (data[i * 16] >>> 4) & 0xf;
            if (coefIndex > 5)
                coefIndex = 0;

            let shiftFactor = data[i * 16] & 0xf;
            if (shiftFactor > 12)
                shiftFactor = 9;
            shiftFactor = (20 - shiftFactor) & 0xff;

            const flags = data[i * 16 + 1];

            for (let s = 0; s < SPU2.NUM_BLOCK_SAMPLES; ++s) {
                let sample = 0;

                if (flags < 0x07)
                {
                    const nibbles = data[i * 16 + 2 + ((s / 2) >>> 0)];

                    sample = ((s & 1) === 1
                        ? ((nibbles >>> 4) << 28 >> 28)
                        : ((nibbles & 0xf) << 28 >> 28));
                    sample <<= shiftFactor;
                    sample += ((SPU2.SPU_ADPCM_COEFS[coefIndex * 2] * h1 + SPU2.SPU_ADPCM_COEFS[coefIndex * 2 + 1] * h2) * 256) >> 0;
                    sample >>= 8;
                }

                channelData[sOut] = sample / 32768.0;
                ++sOut;

                h2 = h1;
                h1 = sample;
            }
        }

        return {
            audioBuffer,
            loop,
            loopStart: (loopStartBlock - startBlock) * SPU2.NUM_BLOCK_SAMPLES / SPU2.VOICE_SAMPLE_RATE,
            loopEnd: (endBlock - startBlock) * SPU2.NUM_BLOCK_SAMPLES / SPU2.VOICE_SAMPLE_RATE
        };
    }

    protected getSampleBuffer(addr: SampleBufferAndOffset): DecodedBuffer {
        let sampleBuffer = this.sampleBuffers.get(addr.buffer);
        if (sampleBuffer === undefined) {
            sampleBuffer = {
                decodedBuffers: new Map<number, DecodedBuffer>()
            };
            this.sampleBuffers.set(addr.buffer, sampleBuffer);
        }
        let buffer = sampleBuffer.decodedBuffers.get(addr.offset);
        if (buffer !== undefined) {
            return buffer;
        } else {
            buffer = this.decodeSample(addr.buffer, addr.offset);
            sampleBuffer.decodedBuffers.set(addr.offset, buffer);
            return buffer;
        }
    }

    private makeAudioBufferSource(addr: SampleBufferAndOffset): AudioBufferSourceNode {
        const buffer = this.getSampleBuffer(addr);
        const source = this.audioContext.createBufferSource();
        source.buffer = buffer.audioBuffer;
        source.loop = buffer.loop;
        source.loopStart = buffer.loopStart;
        source.loopEnd = buffer.loopEnd;
        return source;
    }

    private static _scheduleRampTo(baseTime: number, gainNode: GainNode, state: EnvelopeState, target: number, rate: number, rateMask: number, direction: RateDirection, mode: RateMode, phaseInvert: boolean) {
        if (state.complete) {
            return;
        }
        if (state.needsCancel) {
            SPU2.debugVoice(state.voice, `  [ADSR][CancelAndHold]`);
            gainNode.gain.cancelAndHoldAtTime(baseTime + state.sample / SPU2.VOICE_SAMPLE_RATE);
            state.needsCancel = false;
        }

        // References:
        // https://psx-spx.consoledev.net/soundprocessingunitspu/#envelope-operation-depending-on-shiftstepmodedirection
        // https://github.com/stenzek/duckstation/blob/31ab18b25ffa3b19ddd6d4fa92e8f8a12320a79b/src/core/spu.cpp#L1737
        phaseInvert = phaseInvert && !(direction === RateDirection.Decreasing && mode === RateMode.Exponential);
        let counterIncrement = 0x8000;
        const baseStep = 7 - (rate & 0x3);
        const decreasingXorPhaseInvert =
            (direction === RateDirection.Decreasing && !phaseInvert) ||
            (direction !== RateDirection.Decreasing && phaseInvert);
        let step = (decreasingXorPhaseInvert ||
            (direction === RateDirection.Decreasing && mode === RateMode.Exponential))
            ? ~baseStep : baseStep;
        if (rate < 44) {
            step <<= 11 - (rate >> 2);
        } else if (rate >= 48) {
            counterIncrement >>= (rate >> 2) - 11;
            if ((rate & rateMask) != rateMask) {
                counterIncrement = Math.max(counterIncrement, 1);
            } else {
                // All bits set => locked in as constant level, no further automations to schedule.
                SPU2.debugVoice(state.voice, `  [ADSR]  Complete`);
                state.complete = true;
                return;
            }
        }

        function linearRamp(thisIncrement: number, thisStep: number, thisTarget: number) {
            // Easily-solved linear equation to accurately match the ramp performed by the original
            // hardware (sans quantization errors).
            const stepAdj = thisStep * thisIncrement / 0x8000;
            const targetSample = (thisTarget - state.level) / stepAdj + state.sample;
            gainNode.gain.linearRampToValueAtTime(thisTarget / 0x7fff, baseTime + targetSample / SPU2.VOICE_SAMPLE_RATE);
            state.sample = targetSample;
            state.level = thisTarget;
            SPU2.debugVoice(state.voice, `  [ADSR]  Linear (${state.sample},${state.level})`);
        }

        function exponentialDecayRamp() {
            // SPU exponential decay is extremely difficult to accurately implement in Web Audio.
            // The original hardware iteratively multiplies its decay rate by the current output level,
            // incurring quantization errors every few samples, stretching out until a 1:1 linear
            // decay is reached. (Yes I know per-sample AudioWorklets are an option, but it's really
            // not worth the processing expense or complexity).
            //
            // Instead, some magic values and basic rate combination provide a close-enough fit
            // timeConstant to be used with the exponential decay of setTargetAtTime. This is
            // well within 1ms sample error for the first 95% of the decay on a typical note's timing,
            // though lacking the linear decay at the end, meaning the note runs longer (theoretically
            // infinitely longer due to asymptotic convergence). However, by this point the level is
            // way too low to matter, and Web Audio stops processing nodes below an inaudible gain threshold.
            //
            // Web Audio was never going to be sample-accurate anyway.
            const delta = state.level - target;
            if (delta === 0) {
                return;
            }
            const stepAdj = step * counterIncrement / 0x8000;
            const approximateSampleCount = (-180000 / stepAdj * delta / 0x7fff) >>> 0;
            const timeConstant = approximateSampleCount / 5.2 / SPU2.VOICE_SAMPLE_RATE;
            gainNode.gain.setTargetAtTime(target / 0x7fff, baseTime + state.sample / SPU2.VOICE_SAMPLE_RATE, timeConstant);
            state.sample += approximateSampleCount;
            state.level = target;
            state.needsCancel = true;
            SPU2.debugVoice(state.voice, `  [ADSR]  Exponential ${timeConstant} (${state.sample},${state.level})`);
        }

        if (mode === RateMode.Exponential) {
            if (direction === RateDirection.Decreasing) {
                exponentialDecayRamp();
            } else {
                // Exponential increasing on the other hand is super easy.
                // It's a two-part piecewise-linear function around y === 0x6000,
                // shallowing above this threshold.
                if (state.level < 0x6000) {
                    if (target <= 0x6000) {
                        linearRamp(counterIncrement, step, target);
                        return;
                    } else {
                        linearRamp(counterIncrement, step, 0x6000);
                    }
                }
                if (rate < 40) {
                    linearRamp(counterIncrement, step >> 2, target);
                } else if (rate >= 44) {
                    linearRamp(counterIncrement >> 2, step, target);
                } else {
                    linearRamp(counterIncrement >> 1, step >> 1, target);
                }
            }
        } else {
            linearRamp(counterIncrement, step, target);
        }
    }

    private static _scheduleKeyOnADSR(time: number, voice: SPUVoice) {
        const adsr = voice.adsr;
        const state: EnvelopeState = {
            voice,
            sample: 0,
            level: 0,
            complete: false,
            needsCancel: false
        };

        SPU2.debugVoice(voice, `  [ADSR][CancelAndHold+SetValue0]`);
        voice.adsrGainNode.gain.cancelAndHoldAtTime(time);
        voice.adsrGainNode.gain.setValueAtTime(0, time);

        SPU2.debugVoice(voice, `  [ADSR][Attack]`);
        SPU2._scheduleRampTo(time, voice.adsrGainNode, state, 0x7fff, adsr.ar & 0x7f, 0x7f, RateDirection.Increasing, adsr.ar_m, false);
        if (state.complete) {
            assert(state.sample !== 0, `Key-on for voice ${voice.index} didn't seem to schedule anything`);
            return;
        }

        SPU2.debugVoice(voice, `  [ADSR][Decay]`);
        const decayTarget = Math.min((adsr.sl + 1) * 0x800, 0x7fff);
        SPU2._scheduleRampTo(time, voice.adsrGainNode, state, decayTarget, (adsr.dr & 0xf) << 2, 0x1f << 2, RateDirection.Decreasing, RateMode.Exponential, false);
        if (state.complete) {
            assert(state.sample !== 0, `Key-on for voice ${voice.index} didn't seem to schedule anything`);
            return;
        }

        SPU2.debugVoice(voice, `  [ADSR][Sustain]`);
        const sustainTarget = adsr.sr_s === RateDirection.Increasing ? 0x7fff : 0x0;
        SPU2._scheduleRampTo(time, voice.adsrGainNode, state, sustainTarget, adsr.sr & 0x7f, 0x7f, adsr.sr_s, adsr.sr_m, false);

        assert(state.sample !== 0, `Key-on for voice ${voice.index} didn't seem to schedule anything`);
    }

    private static _scheduleKeyOffADSR(time: number, voice: SPUVoice) {
        const adsr = voice.adsr;

        // TODO: Calculate accurate current level by replaying key-on and solving the matching ramp piece (if it exists)
        let estimatedLevel = Math.min((adsr.sl + 1) * 0x800, 0x7fff);

        const state: EnvelopeState = {
            voice,
            sample: 0,
            level: estimatedLevel,
            complete: false,
            needsCancel: false
        };

        SPU2.debugVoice(voice, `  [ADSR][CancelAndHold]`);
        voice.adsrGainNode.gain.cancelAndHoldAtTime(time);

        SPU2.debugVoice(voice, `  [ADSR][Release]`);
        SPU2._scheduleRampTo(time, voice.adsrGainNode, state, 0, (adsr.rr & 0x1f) << 2, 0x1f << 2, RateDirection.Decreasing, adsr.rr_m, false);

        assert(state.sample !== 0, `Key-off for voice ${voice.index} didn't seem to schedule anything`);
    }

    private static _setVoiceAttr(time: number, attr: SpuVoiceAttr, voice: SPUVoice) {
        if (attr.volume !== undefined) {
            // TODO: Inverted phase?
            if (attr.volume.left !== undefined) {
                assert(attr.volume.left >= 0 && attr.volume.left <= 0x3fff);
                voice.leftGainNode.gain.setValueAtTime(attr.volume.left / 0x3fff, time);
            }
            if (attr.volume.right !== undefined) {
                assert(attr.volume.right >= 0 && attr.volume.right <= 0x3fff);
                voice.rightGainNode.gain.setValueAtTime(attr.volume.right / 0x3fff, time);
            }
        }
        if (attr.addr !== undefined) {
            voice.addr = attr.addr;
        }
        if (attr.pitch !== undefined) {
            voice.pitch = attr.pitch / 0x1000;
            if (voice.sourceNode !== null) {
                voice.sourceNode.playbackRate.setValueAtTime(voice.pitch, time);
            }
        }
        if (attr.adsr1 !== undefined) {
            voice.adsr.sl = (attr.adsr1 >>> 0) & 0xf;
            voice.adsr.dr = (attr.adsr1 >>> 4) & 0xf;
            voice.adsr.ar = (attr.adsr1 >>> 8) & 0x3f;
            voice.adsr.ar_m = ((attr.adsr1 >>> 15) & 0x1) ? RateMode.Exponential : RateMode.Linear;
        }
        if (attr.adsr2 !== undefined) {
            voice.adsr.rr = (attr.adsr2 >>> 0) & 0x1f;
            voice.adsr.rr_m = ((attr.adsr2 >>> 5) & 0x1) ? RateMode.Exponential : RateMode.Linear;
            voice.adsr.sr = (attr.adsr2 >>> 6) & 0x7f;
            voice.adsr.sr_s = ((attr.adsr2 >>> 14) & 0x1) ? RateDirection.Decreasing : RateDirection.Increasing;
            voice.adsr.sr_m = ((attr.adsr2 >>> 15) & 0x1) ? RateMode.Exponential : RateMode.Linear;
        }
    }

    public setVoiceAttr(time: number, attr: SpuVoiceAttr) {
        for (let i = 0; i < SPU2.NUM_VOICES; ++i) {
            if (attr.voiceMask & (1 << i)) {
                const voice = this.voices[i];
                SPU2._setVoiceAttr(time, attr, voice);
            }
        }
    }

    private _setVoiceKeyOn(time: number, voice: SPUVoice) {
        if (voice.sourceNode !== null) {
            voice.sourceNode.stop(time);
        }
        const addr = assertExists(voice.addr)
        voice.sourceNode = this.makeAudioBufferSource(addr);
        voice.sourceNode.playbackRate.value = voice.pitch;
        voice.sourceNode.connect(voice.adsrGainNode);
        SPU2._scheduleKeyOnADSR(time, voice);
        voice.sourceNode.start(time);
    }

    public setKeyOn(time: number, voiceMask: number) {
        for (let i = 0; i < SPU2.NUM_VOICES; ++i) {
            if (voiceMask & (1 << i)) {
                const voice = this.voices[i];
                this._setVoiceKeyOn(time, voice);
            }
        }
    }

    public setKeyOnWithAttr(time: number, attr: SpuVoiceAttr) {
        for (let i = 0; i < SPU2.NUM_VOICES; ++i) {
            if (attr.voiceMask & (1 << i)) {
                const voice = this.voices[i];
                if (voice.sourceNode !== null) {
                    voice.sourceNode.stop(time);
                    voice.sourceNode = null;
                }
                SPU2._setVoiceAttr(time, attr, voice);
                this._setVoiceKeyOn(time, voice);
            }
        }
    }

    private static _setVoiceKeyOff(time: number, voice: SPUVoice) {
        this._scheduleKeyOffADSR(time, voice);
    }

    public setKeyOff(time: number, voiceMask: number) {
        for (let i = 0; i < SPU2.NUM_VOICES; ++i) {
            if (voiceMask & (1 << i)) {
                const voice = this.voices[i];
                SPU2._setVoiceKeyOff(time, voice);
            }
        }
    }
}
