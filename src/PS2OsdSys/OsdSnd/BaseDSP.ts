import {assertExists} from "../../util";
import ArrayBufferSlice from "../../ArrayBufferSlice";
import {SceneAudioContext} from "../../viewer";

/**
 * Provides a common foundation for emulating DSPs.
 *
 * For accurate timing with minimal browser load, BaseDSP manages a latency
 * window within which derived classes set up AudioNodes and schedule their
 * events in the future (at least 100ms by default). The derived class'
 * schedule() is invoked on this latency cadence to keep up with the
 * AudioContext.
 *
 * BaseDSP also provides an interface to fetch voice states for the UI.
 */
export default abstract class BaseDSP {
    private lastScheduledTo: number | null = null;
    private timeoutId: number | null = null;
    private running: boolean = false;

    protected constructor(protected audioContext: SceneAudioContext, private readonly schedulingLatency = 0.1) {
    }

    private _scheduleTimeout(): void {
        const from = assertExists(this.lastScheduledTo);
        const currentTime = this.audioContext.audioContext.currentTime;
        const timeToOverrun = from - currentTime;
        const halfSchedulingLatency = this.schedulingLatency / 2;

        // Try to keep at least 1.5 latency windows ahead.
        const to = timeToOverrun < halfSchedulingLatency
            ? currentTime + this.schedulingLatency + halfSchedulingLatency
            : from + this.schedulingLatency;

        //console.debug(`[SCHEDULE] Now: ${currentTime} (d${from - currentTime}) From ${from} (d${to - from}) To: ${to}`);
        this.schedule!(from, to);
        this.lastScheduledTo = to;

        // Try to reschedule when we have just less than 1 latency window.
        const timeToWait = to - this.schedulingLatency - this.audioContext.audioContext.currentTime;
        this.timeoutId = setTimeout(this._scheduleTimeout.bind(this), Math.max(0, timeToWait * 1000));
    }

    public start(): void {
        if (this.running || !this.schedule)
            return;
        this.running = true;

        this.lastScheduledTo = this.audioContext.audioContext.currentTime + this.schedulingLatency;
        this.timeoutId = setTimeout(this._scheduleTimeout.bind(this), 0);
    }

    public stop(): void {
        if (!this.running)
            return;
        this.running = false;

        if (this.timeoutId !== null) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
    }

    protected abstract schedule?(from: number, to: number): void;
}
