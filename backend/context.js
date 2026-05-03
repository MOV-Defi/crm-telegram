const { AsyncLocalStorage } = require('async_hooks');

const asyncLocalStorage = new AsyncLocalStorage();

const runWithContext = (context, fn) => {
    return asyncLocalStorage.run(context, fn);
};

const getContext = () => {
    return asyncLocalStorage.getStore() || {};
};

const getUserId = () => {
    return getContext().userId;
};

module.exports = {
    asyncLocalStorage,
    runWithContext,
    getContext,
    getUserId
};
