"use strict";

class NodeSDK {
	start() {}
	shutdown() {
		return Promise.resolve();
	}
}

module.exports = { NodeSDK };
