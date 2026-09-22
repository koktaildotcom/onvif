const assert = require('assert');
const { EventEmitter } = require('events');
const onvif = require('../lib/onvif');

/**
 * A pull loop on a device that accepts a pull point and then answers every pull with a fault. The
 * loop is driven directly, so the test needs no device and no mock server.
 */
function buildFailingLoop() {
	const cam = new EventEmitter();
	const state = { subscriptions: 0 };

	cam.events = { messageLimit: 10, subscription: { subscriptionId: '1' }, terminationTime: Date.now() + 60000 };
	cam.pullMessages = (options, callback) =>
		setImmediate(() => callback.call(cam, new Error('ONVIF SOAP Fault: Sender')));
	cam.unsubscribe = (callback) => {
		delete cam.events.subscription;
		delete cam.events.terminationTime;
		if (callback) {
			setImmediate(() => callback.call(cam, null, {}, ''));
		}
	};
	cam.createPullPointSubscription = (callback) => {
		state.subscriptions++;
		cam.events.subscription = { subscriptionId: String(state.subscriptions + 1) };
		cam.events.terminationTime = Date.now() + 60000;
		setImmediate(() => callback.call(cam, null));
	};
	cam._eventPull = onvif.Cam.prototype._eventPull;
	cam._eventRequest = onvif.Cam.prototype._eventRequest;
	cam._restartEventRequest = onvif.Cam.prototype._restartEventRequest;

	cam.on('event', () => {});
	cam.on('eventsError', () => {});

	return { cam, state };
}

/** Ends the loop the way a consumer does: no listeners left and no subscription to pull from. */
function stop(cam) {
	cam.removeAllListeners();
	delete cam.events.subscription;
	delete cam.events.terminationTime;
}

describe('Events resubscribe interval', () => {
	it('waits before it asks the device for a new pull point', (done) => {
		const { cam, state } = buildFailingLoop();
		cam._eventPull();

		setTimeout(() => {
			assert.strictEqual(state.subscriptions, 0, 'a new pull point was requested without waiting');
			setTimeout(() => {
				assert.ok(state.subscriptions >= 1, 'the pull point was never rebuilt');
				assert.ok(state.subscriptions <= 2, `the loop ran ${state.subscriptions} times in 1.5 seconds`);
				stop(cam);
				done();
			}, 1300);
		}, 200);
	}).timeout(5000);

	it('widens the interval while the device keeps failing', (done) => {
		const { cam } = buildFailingLoop();
		cam._eventPull();

		setTimeout(() => {
			assert.ok(cam._eventReconnectms > 1000, `interval stayed at ${cam._eventReconnectms}`);
			stop(cam);
			done();
		}, 2500);
	}).timeout(6000);
});
