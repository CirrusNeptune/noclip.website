import {nArray} from "../util";
import {clamp} from "../MathHelpers";

/**
 * Tower visualization values from the memory card file saved at
 * mc[0-1]:/BRDATA-SYSTEM/history
 *
 * Up to 21 game entries are stored which track the player's play history of
 * each.
 */
export interface MCHistoryEntry {
    /**
     * True if this history slot is occupied by a game.
     * This is a non-empty string of the game ID in the original.
     */
    allocated: boolean,

    /**
     * Running count of times the game has been launched, capped at 127.
     * As this increases, a tower is "grown" on the opening screen over 14
     * launches, then a repeating 10 launch cadence after. A total of 6 towers
     * (localized in tetromino-like clusters) are fully grown by the 63rd
     * launch.
     */
    launchCount: number,

    /**
     * Starting at the 14th launch, a random bit[0:5] is set (re-rolling until
     * an unset one is found) every 10 launches. This pattern continues until
     * 63 launches where all bits are expected to be set. This is how the
     * next tower within the game's cluster is selected. It also keeps the
     * history of already-grown towers.
     */
    randomProgressBits: number,

    /**
     * The most recently set bit in randomProgressBits. This represents the
     * current tower in the cluster being grown. The special value 7 indicates
     * all towers are fully grown.
     */
    lastSetProgressBit: number,
}

/**
 * Copied from JPARandom
 */
interface Random {
    state: number;
}

function next_rndm(random: Random): number {
    random.state = (random.state * 0x19660d + 0x3c6ef35f) >>> 0;
    return random.state;
}

function get_rndm_f(random: Random): number {
    return next_rndm(random) / 0xFFFFFFFF;
}

export interface PlayerSimulationParams {
    /**
     * Number of games in player's collection
     */
    numGames: number;

    /**
     * Number of play sessions
     */
    numSessions: number;

    /**
     * Slot allocation seed
     */
    gameSlotAllocationSeed: number;

    /**
     * Favorite game distribution seed
     */
    favoriteDistributionSeed: number;

    /**
     * Game selection seed
     */
    gameSelectionSeed: number;
}

export const NUM_HISTORY_SLOTS = 21;

/**
 * Rather than spending time curating history files in a PS2 emulator, this
 * provides a procedural approach to simulating a player with a weighted
 * distribution of favorite games.
 */
export function simulatePlayer(params: PlayerSimulationParams): MCHistoryEntry[] {
    const result: MCHistoryEntry[] = nArray(NUM_HISTORY_SLOTS, () => {
        return {
            allocated: false,
            launchCount: 0,
            randomProgressBits: 0,
            lastSetProgressBit: 0,
        };
    });

    // We just clamp the collection at 21. The real BIOS has additional eviction logic.
    const numGames = clamp(params.numGames, 0, NUM_HISTORY_SLOTS);

    // First build a random mapping of games to history slots.
    // In the real BIOS this happens on the game's first launch.
    const allocationTable: number[] = nArray(numGames, () => { return 0; });
    const allocationRandom: Random = { state: params.gameSlotAllocationSeed };
    for (let i = 0; i < numGames; ++i) {
        let chosenSlot;
        do {
            chosenSlot = next_rndm(allocationRandom) % NUM_HISTORY_SLOTS;
        } while (result[chosenSlot].allocated);
        result[chosenSlot].allocated = true;
        allocationTable[i] = chosenSlot;
    }

    // Next build a weighted distribution of the player's favorites.
    // Each entry is the upper bound of a normalized weight span.
    const favoriteDistribution = nArray(numGames, () => { return 0.0; });
    let favoriteTally = 0.0;
    const favoriteRandom: Random = { state: params.favoriteDistributionSeed };
    for (let i = 0; i < numGames; ++i) {
        favoriteTally += get_rndm_f(favoriteRandom);
        favoriteDistribution[i] = favoriteTally;
    }
    for (let i = 0; i < numGames; ++i) {
        favoriteDistribution[i] /= favoriteTally;
    }

    // The first entry >= a [0,1] roll means that game has been chosen.
    const selectionRandom: Random = { state: params.gameSelectionSeed };
    const selectGame = () => {
        const roll = get_rndm_f(selectionRandom);
        for (let i = 0; i < numGames; ++i) {
            if (favoriteDistribution[i] >= roll) {
                return i;
            }
        }
        return 0;
    };

    // Perform the simulation.
    for (let i = 0; i < params.numSessions; ++i) {
        const gameIdx = selectGame();
        const slotIdx = allocationTable[gameIdx];
        const entry = result[slotIdx];
        if ((entry.randomProgressBits & 0x3f) === 0x3f) {
            if (entry.launchCount < 0x3f) {
                entry.launchCount += 1;
            } else {
                entry.launchCount = 63;
                entry.lastSetProgressBit = 7;
            }
        } else {
            const newCount = Math.min(127, entry.launchCount + 1);
            if (newCount >= 14 && (newCount - 14) % 10 === 0) {
                let chosenBit;
                do {
                    chosenBit = next_rndm(selectionRandom) % 6;
                } while ((entry.randomProgressBits >>> chosenBit) & 1);
                entry.lastSetProgressBit = chosenBit;
                entry.randomProgressBits |= 1 << chosenBit;
            } else if (newCount === 1) {
                entry.lastSetProgressBit = 0;
                entry.randomProgressBits = 0x1;
            }
            entry.launchCount = newCount;
        }
    }

    return result;
}
