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

/**
 * An event loop on a device that turns the first requests for a pull point down with a fault and
 * accepts the one after those.
 */
function buildRejectingLoop(rejections, message = 'ONVIF SOAP Fault: Sender') {
	const cam = new EventEmitter();
	const state = { attempts: 0, pulls: 0, errors: 0 };

	cam.events = {};
	cam.createPullPointSubscription = (callback) => {
		state.attempts++;
		if (state.attempts <= rejections) {
			setImmediate(() => callback.call(cam, new Error(message)));
			return;
		}
		cam.events.subscription = { subscriptionId: String(state.attempts) };
		cam.events.terminationTime = Date.now() + 60000;
		setImmediate(() => callback.call(cam, null));
	};
	cam.pullMessages = () => {
		state.pulls++;
	};
	cam.unsubscribe = () => {};
	cam._eventPull = onvif.Cam.prototype._eventPull;
	cam._eventRequest = onvif.Cam.prototype._eventRequest;
	cam._restartEventRequest = onvif.Cam.prototype._restartEventRequest;

	cam.on('event', () => {});
	cam.on('eventsError', () => {
		state.errors++;
	});

	return { cam, state };
}

describe('Events resubscribe interval', () => {
	it('asks again for a pull point the device turned down with a fault', (done) => {
		const { cam, state } = buildRejectingLoop(1);
		cam._eventRequest();

		setTimeout(() => {
			assert.strictEqual(state.attempts, 1, 'the pull point was asked for again without waiting');
			assert.strictEqual(state.errors, 1, 'the fault was not reported');
			setTimeout(() => {
				assert.strictEqual(state.attempts, 2, 'the pull point was never asked for again');
				assert.strictEqual(state.pulls, 1, 'the loop did not pull from the accepted pull point');
				assert.strictEqual(cam._eventReconnectms, undefined, 'the interval was kept after a success');
				stop(cam);
				done();
			}, 1300);
		}, 200);
	}).timeout(5000);

	it('widens the interval while the device keeps turning the pull point down', (done) => {
		const { cam, state } = buildRejectingLoop(Infinity);
		cam._eventRequest();

		setTimeout(() => {
			assert.ok(state.attempts >= 2, `the device was asked ${state.attempts} times`);
			assert.ok(state.attempts <= 3, `the device was asked ${state.attempts} times in 2.5 seconds`);
			assert.ok(cam._eventReconnectms > 1000, `interval stayed at ${cam._eventReconnectms}`);
			assert.strictEqual(state.pulls, 0, 'the loop pulled without a pull point');
			stop(cam);
			done();
		}, 2500);
	}).timeout(6000);

	[
		'Digest authentication failed 401',
		'ONVIF SOAP Fault: {"value":"env:Sender","subcode":{"value":"ter:NotAuthorized"}}',
		'ONVIF SOAP Fault: Sender not Authorized'
	].forEach((message) => {
		it(`leaves a device alone that turned the credentials down with "${message}"`, (done) => {
			const { cam, state } = buildRejectingLoop(1, message);
			cam._eventRequest();

			setTimeout(() => {
				assert.strictEqual(state.attempts, 1, `the device was asked ${state.attempts} times`);
				assert.strictEqual(state.errors, 1, 'the failure was not reported');
				assert.strictEqual(state.pulls, 0, 'the loop pulled without a pull point');
				stop(cam);
				done();
			}, 1500);
		}).timeout(5000);
	});

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
