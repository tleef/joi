'use strict';

// Load modules

const Any = require('../any');
const Async = require('../../async');
const Cast = require('../../cast');
const Ref = require('../../ref');
const Hoek = require('hoek');


// Declare internals

const internals = {};


internals.fastSplice = function (arr, i) {

    let pos = i;
    while (pos < arr.length) {
        arr[pos++] = arr[pos];
    }

    --arr.length;
};


internals.Array = class extends Any {

    constructor() {

        super();
        this._type = 'array';
        this._inner.items = [];
        this._inner.ordereds = [];
        this._inner.inclusions = [];
        this._inner.exclusions = [];
        this._inner.requireds = [];
        this._flags.sparse = false;
    }

    _base(value, state, options, next) {

        const result = {
            value
        };

        if (typeof value === 'string' &&
            options.convert) {

            internals.safeParse(value, result);
        }

        let isArray = Array.isArray(result.value);
        const wasArray = isArray;
        if (options.convert && this._flags.single && !isArray) {
            result.value = [result.value];
            isArray = true;
        }

        if (!isArray) {
            result.errors = this.createError('array.base', null, state, options);
            return next(result);
        }

        if (this._inner.inclusions.length ||
            this._inner.exclusions.length ||
            this._inner.requireds.length ||
            this._inner.ordereds.length ||
            !this._flags.sparse) {

            // Clone the array so that we don't modify the original
            if (wasArray) {
                result.value = result.value.slice(0);
            }

            this._checkItems.call(this, result.value, wasArray, state, options, (errors) => {

                result.errors = errors;

                if (result.errors && wasArray && options.convert && this._flags.single) {

                    // Attempt a 2nd pass by putting the array inside one.
                    const previousErrors = result.errors;

                    result.value = [result.value];
                    this._checkItems.call(this, result.value, wasArray, state, options, (errors) => {

                        result.errors = errors;

                        if (result.errors) {

                            // Restore previous errors and value since this didn't validate either.
                            result.errors = previousErrors;
                            result.value = result.value[0];
                        }

                        return next(result);
                    });
                    return;
                }

                return next(result);
            });
            return;
        }

        return next(result);
    }

    _checkItems(items, wasArray, state, options, next) {

        const errors = [];
        let errored;
        let stripUnknown;
        let requiredChecks;

        const requireds = this._inner.requireds.slice();
        const ordereds = this._inner.ordereds.slice();
        const inclusions = this._inner.inclusions.concat(requireds);

        Async.for(items, (item, i, nextItem) => {

            errored = false;
            let isValid = false;
            const key = wasArray ? i : state.key;
            const path = wasArray ? state.path.concat(i) : state.path;
            const localState = { key, path, parent: state.parent, reference: state.reference };
            let res;

            // Sparse

            if (!this._flags.sparse && item === undefined) {
                errors.push(this.createError('array.sparse', null, { key: state.key, path: localState.path, pos: i }, options));

                if (options.abortEarly) {
                    return next(errors);
                }

                ordereds.shift();

                return nextItem();
            }

            Async.serie([
                (cb) => {

                    Async.for(this._inner.exclusions, (exclusion, j, nextExclusion) => {

                        // Exclusions

                        exclusion._validate(item, localState, {}, null, (res) => {  // Not passing options to use defaults

                            if (!res.errors) {
                                errors.push(this.createError(wasArray ? 'array.excludes' : 'array.excludesSingle', { pos: i, value: item }, { key: state.key, path: localState.path }, options));
                                errored = true;

                                if (options.abortEarly) {
                                    return next(errors);
                                }

                                ordereds.shift();

                                return nextExclusion(true);
                            }

                            nextExclusion();
                        });
                    }, () => {

                        if (errored) {
                            return nextItem();
                        }

                        cb();
                    });
                },
                (cb) => {

                    // Ordered
                    if (this._inner.ordereds.length) {
                        if (ordereds.length > 0) {
                            const ordered = ordereds.shift();
                            ordered._validate(item, localState, options, null, (res) => {

                                if (!res.errors) {
                                    if (ordered._flags.strip) {
                                        internals.fastSplice(items, i);
                                        nextItem.back();
                                        return nextItem();
                                    }
                                    else if (!this._flags.sparse && res.value === undefined) {
                                        errors.push(this.createError('array.sparse', null, { key: state.key, path: localState.path, pos: i }, options));

                                        if (options.abortEarly) {
                                            return next(errors);
                                        }

                                        return nextItem();
                                    }
                                    else {
                                        items[i] = res.value;
                                    }
                                }
                                else {
                                    errors.push(this.createError('array.ordered', { pos: i, reason: res.errors, value: item }, { key: state.key, path: localState.path }, options));
                                    if (options.abortEarly) {
                                        return next(errors);
                                    }
                                }
                                return nextItem();
                            });
                            return;
                        }
                        else if (!this._inner.items.length) {
                            errors.push(this.createError('array.orderedLength', { pos: i, limit: this._inner.ordereds.length }, { key: state.key, path: localState.path }, options));
                            if (options.abortEarly) {
                                return next(errors);
                            }
                            return nextItem();
                        }
                    }
                    cb();
                },
                (cb) => {

                    // Requireds

                    requiredChecks = [];
                    Async.for(requireds, (required, j, nextRequired) => {

                        required._validate(item, localState, options, null, (res) => {

                            requiredChecks[j] = res;

                            if (!res.errors) {
                                items[i] = res.value;
                                isValid = true;
                                internals.fastSplice(requireds, j);

                                if (!this._flags.sparse && res.value === undefined) {
                                    errors.push(this.createError('array.sparse', null, { key: state.key, path: localState.path, pos: i }, options));

                                    if (options.abortEarly) {
                                        return next(errors);
                                    }
                                }

                                return nextRequired(true);
                            }

                            nextRequired();
                        });
                    }, () => {

                        if (isValid) {
                            return nextItem();
                        }

                        cb();
                    });
                },
                (cb) => {

                    // Inclusions

                    stripUnknown = options.stripUnknown
                        ? (options.stripUnknown === true ? true : !!options.stripUnknown.arrays)
                        : false;

                    Async.for(inclusions, (inclusion, j, nextInclusion) => {

                        Async.serie([
                            (cb) => {

                                // Avoid re-running requireds that already didn't match in the previous loop
                                const previousCheck = requireds.indexOf(inclusion);
                                if (previousCheck !== -1) {
                                    res = requiredChecks[previousCheck];
                                    return cb();
                                }
                                else {
                                    inclusion._validate(item, localState, options, null, (_res) => {

                                        res = _res;

                                        if (!res.errors) {
                                            if (inclusion._flags.strip) {
                                                internals.fastSplice(items, i);
                                                nextItem.back();
                                            }
                                            else if (!this._flags.sparse && res.value === undefined) {
                                                errors.push(this.createError('array.sparse', null, { key: state.key, path: localState.path, pos: i }, options));
                                                errored = true;
                                            }
                                            else {
                                                items[i] = res.value;
                                            }
                                            isValid = true;
                                            return nextInclusion(true);
                                        }

                                        return cb();
                                    });
                                }
                            },
                            (cb) => {
                                // Return the actual error if only one inclusion defined
                                if (inclusions.length === 1) {
                                    if (stripUnknown) {
                                        internals.fastSplice(items, i);
                                        nextItem.back();
                                        isValid = true;
                                        return nextInclusion(true);
                                    }

                                    errors.push(this.createError(wasArray ? 'array.includesOne' : 'array.includesOneSingle', { pos: i, reason: res.errors, value: item }, { key: state.key, path: localState.path }, options));
                                    errored = true;

                                    if (options.abortEarly) {
                                        return next(errors);
                                    }

                                    return nextInclusion(true);
                                }
                                cb();
                            }
                        ], nextInclusion);
                    }, () => {

                        if (errored) {
                            return nextItem();
                        }

                        cb();
                    });
                },
                (cb) => {

                    if (this._inner.inclusions.length && !isValid) {
                        if (stripUnknown) {
                            internals.fastSplice(items, i);
                            nextItem.back();
                            return nextItem();
                        }

                        errors.push(this.createError(wasArray ? 'array.includes' : 'array.includesSingle', { pos: i, value: item }, { key: state.key, path: localState.path }, options));

                        if (options.abortEarly) {
                            return next(errors);
                        }
                    }
                    cb();
                }
            ], nextItem);
        }, () => {

            if (requireds.length) {
                this._fillMissedErrors.call(this, errors, requireds, state, options);
            }

            if (ordereds.length) {
                this._fillOrderedErrors.call(this, errors, ordereds, state, options);
            }

            return next(errors.length ? errors : null);
        });
    }

    describe() {

        const description = Any.prototype.describe.call(this);

        if (this._inner.ordereds.length) {
            description.orderedItems = [];

            for (let i = 0; i < this._inner.ordereds.length; ++i) {
                description.orderedItems.push(this._inner.ordereds[i].describe());
            }
        }

        if (this._inner.items.length) {
            description.items = [];

            for (let i = 0; i < this._inner.items.length; ++i) {
                description.items.push(this._inner.items[i].describe());
            }
        }

        return description;
    }

    items(...schemas) {

        const obj = this.clone();

        Hoek.flatten(schemas).forEach((type, index) => {

            try {
                type = Cast.schema(this._currentJoi, type);
            }
            catch (castErr) {
                if (castErr.hasOwnProperty('path')) {
                    castErr.path = index + '.' + castErr.path;
                }
                else {
                    castErr.path = index;
                }
                castErr.message = castErr.message + '(' + castErr.path + ')';
                throw castErr;
            }

            obj._inner.items.push(type);

            if (type._flags.presence === 'required') {
                obj._inner.requireds.push(type);
            }
            else if (type._flags.presence === 'forbidden') {
                obj._inner.exclusions.push(type.optional());
            }
            else {
                obj._inner.inclusions.push(type);
            }
        });

        return obj;
    }

    ordered(...schemas) {

        const obj = this.clone();

        Hoek.flatten(schemas).forEach((type, index) => {

            try {
                type = Cast.schema(this._currentJoi, type);
            }
            catch (castErr) {
                if (castErr.hasOwnProperty('path')) {
                    castErr.path = index + '.' + castErr.path;
                }
                else {
                    castErr.path = index;
                }
                castErr.message = castErr.message + '(' + castErr.path + ')';
                throw castErr;
            }
            obj._inner.ordereds.push(type);
        });

        return obj;
    }

    min(limit) {

        const isRef = Ref.isRef(limit);

        Hoek.assert((Number.isSafeInteger(limit) && limit >= 0) || isRef, 'limit must be a positive integer or reference');

        return this._test('min', limit, function (value, state, options) {

            let compareTo;
            if (isRef) {
                compareTo = limit(state.reference || state.parent, options);

                if (!(Number.isSafeInteger(compareTo) && compareTo >= 0)) {
                    return this.createError('array.ref', { ref: limit.key }, state, options);
                }
            }
            else {
                compareTo = limit;
            }

            if (value.length >= compareTo) {
                return value;
            }

            return this.createError('array.min', { limit, value }, state, options);
        });
    }

    max(limit) {

        const isRef = Ref.isRef(limit);

        Hoek.assert((Number.isSafeInteger(limit) && limit >= 0) || isRef, 'limit must be a positive integer or reference');

        return this._test('max', limit, function (value, state, options) {

            let compareTo;
            if (isRef) {
                compareTo = limit(state.reference || state.parent, options);

                if (!(Number.isSafeInteger(compareTo) && compareTo >= 0)) {
                    return this.createError('array.ref', { ref: limit.key }, state, options);
                }
            }
            else {
                compareTo = limit;
            }

            if (value.length <= compareTo) {
                return value;
            }

            return this.createError('array.max', { limit, value }, state, options);
        });
    }

    length(limit) {

        const isRef = Ref.isRef(limit);

        Hoek.assert((Number.isSafeInteger(limit) && limit >= 0) || isRef, 'limit must be a positive integer or reference');

        return this._test('length', limit, function (value, state, options) {

            let compareTo;
            if (isRef) {
                compareTo = limit(state.reference || state.parent, options);

                if (!(Number.isSafeInteger(compareTo) && compareTo >= 0)) {
                    return this.createError('array.ref', { ref: limit.key }, state, options);
                }
            }
            else {
                compareTo = limit;
            }

            if (value.length === compareTo) {
                return value;
            }

            return this.createError('array.length', { limit, value }, state, options);
        });
    }

    unique(comparator, configs) {

        Hoek.assert(comparator === undefined ||
            typeof comparator === 'function' ||
            typeof comparator === 'string', 'comparator must be a function or a string');

        Hoek.assert(configs === undefined ||
            typeof configs === 'object', 'configs must be an object');

        const settings = {
            ignoreUndefined: (configs && configs.ignoreUndefined) || false
        };


        if (typeof comparator === 'string') {
            settings.path = comparator;
        }
        else if (typeof comparator === 'function') {
            settings.comparator = comparator;
        }

        return this._test('unique', settings, function (value, state, options) {

            const found = {
                string: Object.create(null),
                number: Object.create(null),
                undefined: Object.create(null),
                boolean: Object.create(null),
                object: new Map(),
                function: new Map(),
                custom: new Map()
            };

            const compare = settings.comparator || Hoek.deepEqual;
            const ignoreUndefined = settings.ignoreUndefined;

            for (let i = 0; i < value.length; ++i) {
                const item = settings.path ? Hoek.reach(value[i], settings.path) : value[i];
                const records = settings.comparator ? found.custom : found[typeof item];

                // All available types are supported, so it's not possible to reach 100% coverage without ignoring this line.
                // I still want to keep the test for future js versions with new types (eg. Symbol).
                if (/* $lab:coverage:off$ */ records /* $lab:coverage:on$ */) {
                    if (records instanceof Map) {
                        const entries = records.entries();
                        let current;
                        while (!(current = entries.next()).done) {
                            if (compare(current.value[0], item)) {
                                const localState = {
                                    key: state.key,
                                    path: state.path.concat(i),
                                    parent: state.parent,
                                    reference: state.reference
                                };

                                const context = {
                                    pos: i,
                                    value: value[i],
                                    dupePos: current.value[1],
                                    dupeValue: value[current.value[1]]
                                };

                                if (settings.path) {
                                    context.path = settings.path;
                                }

                                return this.createError('array.unique', context, localState, options);
                            }
                        }

                        records.set(item, i);
                    }
                    else {
                        if ((!ignoreUndefined || item !== undefined) && records[item] !== undefined) {
                            const localState = {
                                key: state.key,
                                path: state.path.concat(i),
                                parent: state.parent,
                                reference: state.reference
                            };

                            const context = {
                                pos: i,
                                value: value[i],
                                dupePos: records[item],
                                dupeValue: value[records[item]]
                            };

                            if (settings.path) {
                                context.path = settings.path;
                            }

                            return this.createError('array.unique', context, localState, options);
                        }

                        records[item] = i;
                    }
                }
            }

            return value;
        });
    }

    sparse(enabled) {

        const value = enabled === undefined ? true : !!enabled;

        if (this._flags.sparse === value) {
            return this;
        }

        const obj = this.clone();
        obj._flags.sparse = value;
        return obj;
    }

    single(enabled) {

        const value = enabled === undefined ? true : !!enabled;

        if (this._flags.single === value) {
            return this;
        }

        const obj = this.clone();
        obj._flags.single = value;
        return obj;
    }

    _fillMissedErrors(errors, requireds, state, options) {

        const knownMisses = [];
        let unknownMisses = 0;
        for (let i = 0; i < requireds.length; ++i) {
            const label = requireds[i]._getLabel();
            if (label) {
                knownMisses.push(label);
            }
            else {
                ++unknownMisses;
            }
        }

        if (knownMisses.length) {
            if (unknownMisses) {
                errors.push(this.createError('array.includesRequiredBoth', { knownMisses, unknownMisses }, { key: state.key, path: state.path }, options));
            }
            else {
                errors.push(this.createError('array.includesRequiredKnowns', { knownMisses }, { key: state.key, path: state.path }, options));
            }
        }
        else {
            errors.push(this.createError('array.includesRequiredUnknowns', { unknownMisses }, { key: state.key, path: state.path }, options));
        }
    }


    _fillOrderedErrors(errors, ordereds, state, options) {

        const requiredOrdereds = [];

        for (let i = 0; i < ordereds.length; ++i) {
            const presence = Hoek.reach(ordereds[i], '_flags.presence');
            if (presence === 'required') {
                requiredOrdereds.push(ordereds[i]);
            }
        }

        if (requiredOrdereds.length) {
            this._fillMissedErrors.call(this, errors, requiredOrdereds, state, options);
        }
    }

};


internals.safeParse = function (value, result) {

    try {
        const converted = JSON.parse(value);
        if (Array.isArray(converted)) {
            result.value = converted;
        }
    }
    catch (e) { }
};


module.exports = new internals.Array();
