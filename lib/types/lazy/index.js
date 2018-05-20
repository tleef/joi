'use strict';

// Load modules

const Any = require('../any');
const Hoek = require('hoek');


// Declare internals

const internals = {};


internals.Lazy = class extends Any {

    constructor() {

        super();
        this._type = 'lazy';
    }

    _base(value, state, options, next) {

        const result = { value };
        const lazy = this._flags.lazy;

        if (!lazy) {
            result.errors = this.createError('lazy.base', null, state, options);
            return next(result);
        }

        const schema = lazy();

        if (!(schema instanceof Any)) {
            result.errors = this.createError('lazy.schema', null, state, options);
            return next(result);
        }

        return schema._validate(value, state, options, null, next);
    }

    set(fn) {

        Hoek.assert(typeof fn === 'function', 'You must provide a function as first argument');

        const obj = this.clone();
        obj._flags.lazy = fn;
        return obj;
    }

};

module.exports = new internals.Lazy();
