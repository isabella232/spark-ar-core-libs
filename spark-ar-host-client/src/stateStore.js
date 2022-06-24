/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {createHostManager} from './hostManager';
import Time from 'Time';
import Multipeer from 'Multipeer';
import Diagnostics from 'Diagnostics';

let channelIndex = 0;

export class StateStore {
  constructor(config) {
    this._state = config.initialState;
    this._pendingUpdates = [];
    this._handlerRegistry = config.handlers;
    this._subscriptionRegistry = [];

    this._hostUpdateInterval = config.hostUpdateInterval || 100;
    this._forceBroadcastInterval = config.forceBroadcastInterval || 300;
    this._lastBroadcastTimestamp = Date.now();

    // Our API has intend to only create 1 store for the whole effect, but
    // in case user create multiple for special use cases, add an channelIndex
    // to avoid conflicts in channel usages.
    this._channelIndex = channelIndex++;
    this._stateBroadcastChannel = Multipeer.getMessageChannel(
      'state_broadcast_' + this._channelIndex,
    );
    this._clientRequestChannel = Multipeer.getMessageChannel(
      'client_request_' + this._channelIndex,
    );

    this._config = config;
  }

  async init() {
    this._hostManager = await createHostManager(this._config);

    this._stateBroadcastChannel.onMessage.subscribe(hostState => {
      if (!this._hostManager.getIsSelfHost()) {
        this._updateStates(hostState);
      }
    });

    // everyone all record all the requests, in case we lost host
    this._clientRequestChannel.onMessage.subscribe(payload => {
      if (payload.id === this._hostManager.getParticipantManager().self.id) {
        // just in case, don't push request from yourself
        return;
      }
      this._pendingUpdates.push(payload);
    });
    this.updateEventHandle = Time.setInterval(async () => {
      await this._onInterval();
    }, this._hostUpdateInterval);
  }

  getState() {
    return this._state;
  }

  async dispatch(type, payload) {
    let updatePayload = {
      type: type,
      payload,
      t: Date.now(),
      id: this._hostManager.getParticipantManager().self.id,
    };
    if (this._hostManager.getIsSelfHost()) {
      this._pendingUpdates.push(updatePayload);
    }

    // host will still send out update payload for other client to record
    // in case host drop the other still pickup the requests
    await this._clientRequestChannel.sendMessage(updatePayload);
  }

  subscribe(keys, callback) {
    this._subscriptionRegistry.push({
      keys: keys,
      callback: callback,
    });
  }

  _processEvent(curState, event) {
    for (const handler of this._handlerRegistry) {
      const updatePayload = handler(curState, event);
      if (updatePayload) {
        for (const key in updatePayload) {
          curState[key] = updatePayload[key];
        }
      }
    }
    return curState;
  }

  _updateStates(newState) {
    const preState = this._state;
    this._state = newState;

    // local event trigger
    let updatedKeys = {};
    let hasUpdate = false;
    for (const key in preState) {
      if (preState[key] != this._state[key]) {
        updatedKeys[key] = true;
        hasUpdate = true;
      }
    }

    for (const subscription of this._subscriptionRegistry) {
      for (const subscriptionKey of subscription.keys) {
        if (updatedKeys[subscriptionKey]) {
          subscription.callback(this._state, preState);
          break;
        }
      }
    }

    return hasUpdate;
  }

  async _onInterval() {
    if (this._hostManager.getIsSelfHost()) {
      await this._hostUpdate();
    } else {
      this._pendingUpdates = [];
    }
  }

  async _hostUpdate() {
    const pendingUpdates = this._pendingUpdates;
    this._pendingUpdates = [];

    // sort pending updates by time
    pendingUpdates.sort((a, b) => {
      return a.t - b.t;
    });

    let curState = Object.assign({}, this._state);
    for (const pendingUpdate of pendingUpdates) {
      const event = {
        type: pendingUpdate.type,
        payload: pendingUpdate.payload,
      };
      curState = this._processEvent(curState, event);
    }

    const hasUpdate = this._updateStates(curState);

    // broadcast new state if
    // 1. State updated
    // 2. Hasn't broadcast for a while (in case some client missed previous updates)
    if (hasUpdate || Date.now() - this._lastBroadcastTimestamp >= this._forceBroadcastInterval) {
      this._lastBroadcastTimestamp = Date.now();
      await this._stateBroadcastChannel.sendMessage(curState);
    }
  }
}

export async function createStateStore(config) {
  const stateStore = new StateStore(config);
  await stateStore.init();
  return stateStore;
}
