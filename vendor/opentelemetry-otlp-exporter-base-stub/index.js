"use strict";

const CompressionAlgorithm = {
	NONE: "none",
	GZIP: "gzip",
};

class OTLPExporterError extends Error {}

class OTLPExporterBase {}

function mergeOtlpSharedConfigurationWithDefaults(config) {
	return config;
}

function getSharedConfigurationDefaults() {
	return {};
}

function createOtlpNetworkExportDelegate() {
	return {};
}

module.exports = {
	CompressionAlgorithm,
	OTLPExporterError,
	OTLPExporterBase,
	mergeOtlpSharedConfigurationWithDefaults,
	getSharedConfigurationDefaults,
	createOtlpNetworkExportDelegate,
};
