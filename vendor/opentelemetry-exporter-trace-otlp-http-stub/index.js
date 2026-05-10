"use strict";

class OTLPTraceExporter {
	constructor() {}
	export(_spans, resultCallback) {
		if (typeof resultCallback === "function") {
			resultCallback({ code: 0 });
		}
	}
	async shutdown() {}
}

module.exports = { OTLPTraceExporter };
