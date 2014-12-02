function MsgServer(eventManager) {
	var HttpLongPolling = require('./longpolling.js');
	var HttpShortPolling = require('./shortpolling.js');

	this.transports = {
		'http-longpolling': HttpLongPolling,
		'http-shortpolling': HttpShortPolling
	};

	this.futureLog = {};	// queues up events for soon or immediate emission
	this.expectedMsgId = null;
	this.stream = null;

	this.eventManager = eventManager;
}


/**
 * Creates a stream over which we can receive messages asynchronously
 *
 * @param {string} type     A key to this.transports (eg: 'http-longpolling')
 * @param {Object} options  Options to pass into the transport's constructor
 * @returns {Transport}     The Transport instance
 */

MsgServer.prototype.createTransport = function (type, options) {
	// check transport availability

	var Transport = this.transports[type];
	if (!Transport) {
		throw new Error('No transport type "' + type + '" found.');
	}

	return new Transport(options);
};


/**
 * Queues up messages for later emission
 * @param {Object} messages
 */

MsgServer.prototype.addMessages = function (messages) {
	if (!messages) {
		return;
	}

	if (typeof messages !== 'object') {
		throw new TypeError('Messages passed must be an object');
	}

	var msgIds = Object.keys(messages);

	for (var i = 0; i < msgIds.length; i += 1) {
		var msgId = msgIds[i];
		var msgIdNum = parseInt(msgId, 10);

		// register the message into the futureLog for later emission

		this.futureLog[msgId] = messages[msgId];

		// make sure we are expecting the lowest possible msgId first

		if (this.expectedMsgId === null || msgIdNum < this.expectedMsgId) {
			this.expectedMsgId = msgIdNum;
		}
	}
};


/**
 * Forgets about all currently registered messages. Required after a session key change.
 */

MsgServer.prototype.resetFutureLog = function () {
	this.expectedMsgId = null;
	this.futureLog = {};
};


MsgServer.prototype.emitEvents = function (msgId) {
	var messages = this.futureLog[msgId];

	delete this.futureLog[msgId];

	// Emit the events in the message pack.

	if (messages) {
		this.eventManager.emitEvents(messages);
	}
};


/**
 * Emits as many messages as can be emitted without creating gaps in the flow of msgId keys
 */

MsgServer.prototype.emitFutureLog = function () {
	// Keep emitting until we encounter a gap, or futureLog has simply gone empty

	while (this.futureLog.hasOwnProperty(this.expectedMsgId)) {
		// Early increment expectedMsgId, so that even if an event listener were to throw, the next
		// time we call emitFutureLog, we know that we won't be expecting an old ID.

		var msgId = this.expectedMsgId;

		this.expectedMsgId += 1;

		this.emitEvents(msgId);
	}

	// finally emit any events that don't have an ID and thus don't need confirmation and lack order

	if (this.futureLog.hasOwnProperty('0')) {
		this.emitEvents('0');
	}
};


/**
 * Kills the stream connection. Can be resumed later by calling start().
 */

MsgServer.prototype.abort = function () {
	if (this.stream) {
		this.stream.abort();
	}
};


/**
 * Starts or resumes (after abort() had been called) the stream connection.
 */

MsgServer.prototype.start = function () {
	this.stream.start();
};


/**
 * Configures the message stream with HTTP configuration and a session key. If the key ever changes,
 * this function should be called again.
 *
 * @param {Object} config
 * @param {Object} config.httpOptions
 * @param {string} config.url
 * @param {string} sessionKey
 */

MsgServer.prototype.setupMessageStream = function (config, sessionKey) {
	var that = this;

	// Make sure any lingering messages are wiped out

	this.resetFutureLog();

	// instantiate the event stream if needed

	if (!this.stream) {
		this.stream = this.createTransport('http-longpolling', config.httpOptions);
	}

	// configure the stream with a session-key and callback for responses

	this.stream.setup(config.url, { sessionKey: sessionKey }, null, function (messages) {
		try {
			that.addMessages(messages);
			that.emitFutureLog();
		} catch (error) {
			console.error('Error in msgServer event emission:', error);
		}
	});
};

module.exports = MsgServer;
