const { TriggerConditionTypes, OperatorTypes } = require( '../data/models/trigger' );
const StringUtilities = require( './string' );

/**
 * Returns whether the stored values of the key include the value (or any of the values).
 *
 * @returns {{exists: boolean, value: any}}
 *
 * @param {Record<string, string[]>} stored The stored variables.
 * @param {string} key The key of the stored variable.
 * @param {any|any[]} value The value to check.
 */
function storeHasValue( stored, key, value ) {

    if ( stored[ key ]?.length > 0 ) {
        if ( value instanceof Array ) {
            for ( let i = 0; i < value.length; i++ ) {
                let index = stored[ key ].indexOf( value[ i ] );
                if ( index > -1 ) {
                    return { exists: true, value: value[ i ] };
                }
            }
        } else {
            let index = stored[ key ].indexOf( value );
            return index > -1 ? { exists: true, value: value } : { exists: false };
        }
    }

    return { exists: false };

}

/**
 * Returns whether any stored value of the key contains the value (or any of the values).
 *
 * @returns {{exists: boolean, value: any}}
 *
 * @param {Record<string, string[]>} stored The stored variables.
 * @param {string} key The key of the stored variable.
 * @param {any|any[]} value The value to check.
 */
function storeContainsValue( stored, key, value ) {

    if ( stored[ key ]?.length > 0 && value?.length > 0 ) {
        if ( value instanceof Array ) {
            let values = value.map( v => v.toLowerCase() );
            for ( let i = 0; i < stored[ key ].length; i++ ) {
                for ( let v = 0; v < values.length; v++ ) {
                    if ( stored[ key ][ i ].toLowerCase().indexOf( values[ v ] ) > -1 ) {
                        return { exists: true, value: stored[ key ][ i ] };
                    }
                }
            }
        } else {
            let v = value.toLowerCase();
            for ( let i = 0; i < stored[ key ].length; i++ ) {
                if ( stored[ key ][ i ].toLowerCase().indexOf( v ) > -1 ) {
                    return { exists: true, value: stored[ key ][ i ] };
                }
            }
        }
    }

    return { exists: false };
}

/**
 * Stage 1 of trigger matching: decides which triggers can fire at all right
 * now, from what only changes between log lines (class, stored variables and
 * counters).  The log watcher only runs the open triggers.
 *
 * Conditions that depend on the log line (named group values) are not part of
 * the gate; they are still checked after a match.
 */
class TriggerGate {

    /** @type {() => {storedVariables: Record<string, string[]>, counters: Record<string, {value: number}>, characterClass: string|null|undefined}} */
    #getState;
    /** @type {any[]} */
    #triggers = [];
    /** @type {{condition: any, values: string[]|null}[][]} The variable and counter conditions of each trigger. */
    #conditions = [];
    /** @type {((index: number) => void)|null} Called when a trigger opens after a state change. */
    #onOpen;
    /** @type {Map<string, number[]>} */
    #variableIndex = new Map();
    /** @type {Map<string, number[]>} */
    #counterIndex = new Map();

    /** @type {Uint8Array} 1 where the trigger at that index can fire. */
    open = new Uint8Array( 0 );
    /** True if any trigger opened or closed since the last acknowledge(). */
    changed = false;
    openCount = 0;

    /**
     * @param {() => {storedVariables: Record<string, string[]>, counters: Record<string, {value: number}>, characterClass: string|null|undefined}} getState Returns the current state to gate on.
     * @param {((index: number) => void)|null} onOpen Called with the index of each trigger that opens after build().
     */
    constructor( getState, onOpen ) {
        this.#getState = getState;
        this.#onOpen = onOpen ?? null;
    }

    /**
     * Rebuilds the dependency index and gates every trigger.
     *
     * @param {any[]} triggers The enabled triggers of the character.
     */
    build( triggers ) {
        this.#triggers = triggers;
        this.#conditions = [];
        this.#variableIndex = new Map();
        this.#counterIndex = new Map();

        triggers.forEach( ( trigger, index ) => {
            const all = [ ...( trigger.conditions ?? [] ), ...( trigger._folderConditions ?? [] ) ];

            // Like the trigger's own condition check, the last condition of a variable decides its values.
            /** @type {Record<string, string[]|null>} */
            const values = {};
            all.forEach( condition => {
                values[ condition.variableName ] = condition.variableValue ? condition.variableValue.split( /\|/gi ) : null;
            } );

            const gated = [];
            all.forEach( condition => {
                const isVariable = condition.conditionType === TriggerConditionTypes.VariableValue;
                const isCounter = condition.conditionType === TriggerConditionTypes.CounterValue;
                if ( !isVariable && !isCounter ) {
                    return;
                }

                gated.push( { condition: condition, values: values[ condition.variableName ] } );

                const map = isVariable ? this.#variableIndex : this.#counterIndex;
                const list = map.get( condition.variableName ) ?? [];
                if ( list[ list.length - 1 ] !== index ) {
                    list.push( index );
                }
                map.set( condition.variableName, list );
            } );

            this.#conditions.push( gated );
        } );

        this.open = new Uint8Array( triggers.length );
        this.openCount = 0;
        for ( let i = 0; i < triggers.length; i++ ) {
            this.open[ i ] = this.#evaluate( i ) ? 1 : 0;
            this.openCount += this.open[ i ];
        }
        this.changed = true;
    }

    /**
     * Re-gates the triggers that depend on the stored variable.
     *
     * @param {string} name The variable name.
     */
    variableChanged( name ) {
        this.#regate( this.#variableIndex.get( name ) );
    }

    /**
     * Re-gates the triggers that depend on the counter.
     *
     * @param {string} name The counter name.
     */
    counterChanged( name ) {
        this.#regate( this.#counterIndex.get( name ) );
    }

    /**
     * Re-gates every trigger that has a variable or counter condition.
     */
    allChanged() {
        for ( let i = 0; i < this.#triggers.length; i++ ) {
            this.#regateOne( i );
        }
    }

    /**
     * Marks the changes as handled.
     */
    acknowledge() {
        this.changed = false;
    }

    /**
     * @param {number[]|undefined} indices The triggers to re-gate.
     */
    #regate( indices ) {
        if ( indices ) {
            for ( let i = 0; i < indices.length; i++ ) {
                this.#regateOne( indices[ i ] );
            }
        }
    }

    /**
     * @param {number} index The trigger index.
     */
    #regateOne( index ) {
        const now = this.#evaluate( index ) ? 1 : 0;
        if ( now !== this.open[ index ] ) {
            this.open[ index ] = now;
            this.openCount += now ? 1 : -1;
            this.changed = true;
            if ( now ) {
                this.#onOpen?.( index );
            }
        }
    }

    /**
     * Returns true if the trigger can fire with the current state.
     *
     * @param {number} index The trigger index.
     */
    #evaluate( index ) {
        const trigger = this.#triggers[ index ];
        if ( typeof trigger._parse !== 'function' || trigger._passesClassCondition === false ) {
            return false;
        }

        const state = this.#getState();

        if ( !StringUtilities.isNullOrWhitespace( state.characterClass ) && trigger.classLevels?.length > 0 ) {
            const classLevels = trigger.classLevels.filter( f => f.class?.trim().length > 0 );
            if ( classLevels.length > 0 && !classLevels.some( f => f.class === state.characterClass ) ) {
                return false;
            }
        }

        const conditions = this.#conditions[ index ];
        for ( let i = 0; i < conditions.length; i++ ) {
            if ( !this.#conditionPasses( conditions[ i ].condition, conditions[ i ].values, state ) ) {
                return false;
            }
        }

        return true;
    }

    /**
     * @returns {boolean}
     *
     * @param {any} condition The condition.
     * @param {string[]|null} values The values the condition compares against.
     * @param {{storedVariables: Record<string, string[]>, counters: Record<string, {value: number}>}} state The current state.
     */
    #conditionPasses( condition, values, state ) {
        const name = condition.variableName;

        if ( condition.conditionType === TriggerConditionTypes.VariableValue ) {
            const stored = state.storedVariables;

            if ( condition.operatorType === OperatorTypes.Equals ) {
                return storeHasValue( stored, name, values ).exists;

            } else if ( condition.operatorType === OperatorTypes.IsNull ) {
                return !( stored[ name ]?.length > 0 );

            } else if ( condition.operatorType === OperatorTypes.DoesNotEqual ) {
                if ( values && storeHasValue( stored, name, values ).exists ) {
                    return false;
                }

                return !( values == null && ( stored[ name ] == null || stored[ name ]?.length == 0 ) );

            } else if ( condition.operatorType === OperatorTypes.Contains ) {
                return storeContainsValue( stored, name, values ).exists;
            }

        } else if ( condition.conditionType === TriggerConditionTypes.CounterValue ) {
            const counterValue = state.counters[ name ]?.value ?? null;
            const conditionValue = condition.variableValue && !StringUtilities.isNullOrWhitespace( condition.variableValue ) ? +condition.variableValue : null;
            const conditionNullMatch = counterValue === null && conditionValue === null;

            if ( condition.operatorType === OperatorTypes.Equals ) {
                return conditionNullMatch || counterValue - conditionValue === 0;
            } else if ( condition.operatorType === OperatorTypes.GreaterThan ) {
                return !( conditionNullMatch || counterValue - conditionValue <= 0 );
            } else if ( condition.operatorType === OperatorTypes.LessThan ) {
                return !( conditionNullMatch || conditionValue - counterValue <= 0 );
            } else if ( condition.operatorType === OperatorTypes.DoesNotEqual ) {
                return !( conditionNullMatch || counterValue - conditionValue === 0 );
            }
        }

        return true;
    }

}

module.exports = { TriggerGate, storeHasValue, storeContainsValue };
