'use strict';


exports.for = function (arr, it, next) {

    let i = -1;
    let nextCalled = false;

    if (arr instanceof Set) {
        const setIt = arr.entries();
        const iter = function (arg) {

            if (arg) {
                iter.async = true;
                return next(arg);
            }
            else if (!iter.async) {
                nextCalled = true;
                return;
            }

            iter.async = false;

            while (!iter.async) {
                const cur = setIt.next();
                if (cur.done) {
                    return next();
                }
                else {
                    ++i;
                    it(cur.value[0], i, iter);
                    if (!nextCalled) {
                        return;
                    }
                    nextCalled = false;
                }
            }
        };

        iter.async = true;

        iter.back = function () {

            --i;
        };

        iter();
    }
    else {
        const iter = function (arg) {

            if (arg) {
                iter.async = true;
                return next(arg);
            }
            else if (!iter.async) {
                nextCalled = true;
                return;
            }

            iter.async = false;

            while (!iter.async) {

                if (i + 1 < arr.length) {
                    ++i;
                    it(arr[i], i, iter);
                    if (!nextCalled) {
                        return;
                    }
                    nextCalled = false;
                }
                else {
                    return next();
                }
            }
        };

        iter.async = true;

        iter.back = function () {

            --i;
        };

        iter();
    }
};

exports.serie = function (arr, next) {

    exports.for(arr, (fn, i, cb) => fn(cb), next);
};
