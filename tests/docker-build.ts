/**
 * @license
 * Copyright 2019-2020 Balena Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { expect } from 'chai';
import { stripIndent } from 'common-tags';
import * as _ from 'lodash';
import { fs } from 'mz';
import * as path from 'path';
import { PathUtils } from 'resin-multibuild';
import { Readable } from 'stream';
import * as tar from 'tar-stream';
import { streamToBuffer } from 'tar-utils';
import { URL } from 'url';

import { BuilderMock } from './builder-mock';
import { DockerMock } from './docker-mock';
import { cleanOutput, fillTemplateArray, runCommand } from './helpers';

export interface ExpectedTarStreamFile {
	contents?: string;
	fileSize: number;
	testStream?: (
		header: tar.Headers,
		stream: Readable,
		expected?: ExpectedTarStreamFile,
	) => Promise<void>;
	type: tar.Headers['type'];
}

export interface ExpectedTarStreamFiles {
	[filePath: string]: ExpectedTarStreamFile;
}

export interface ExpectedTarStreamFilesByService {
	[service: string]: ExpectedTarStreamFiles;
}

/**
 * Run a few chai.expect() test assertions on a tar stream/buffer produced by
 * the balena push, build and deploy commands, intercepted at HTTP level on
 * their way from the CLI to the Docker daemon or balenaCloud builders.
 *
 * @param tarRequestBody Intercepted buffer of tar stream to be sent to builders/Docker
 * @param expectedFiles Details of files expected to be found in the buffer
 * @param projectPath Path of test project that was tarred, to compare file contents
 */
export async function inspectTarStream(
	tarRequestBody: string | Buffer,
	expectedFiles: ExpectedTarStreamFiles,
	projectPath: string,
): Promise<void> {
	// string to stream: https://stackoverflow.com/a/22085851
	const sourceTarStream = new Readable();
	sourceTarStream._read = () => undefined;
	sourceTarStream.push(tarRequestBody);
	sourceTarStream.push(null);

	const found: ExpectedTarStreamFiles = await new Promise((resolve, reject) => {
		const foundFiles: ExpectedTarStreamFiles = {};
		const extract = tar.extract();
		extract.on('error', reject);
		extract.on(
			'entry',
			async (header: tar.Headers, stream: Readable, next: tar.Callback) => {
				try {
					// TODO: test the .balena folder instead of ignoring it
					if (header.name.startsWith('.balena/')) {
						stream.resume();
					} else {
						expect(foundFiles).to.not.have.property(header.name);
						foundFiles[header.name] = {
							fileSize: header.size || 0,
							type: header.type,
						};
						const expected = expectedFiles[header.name];
						if (expected && expected.testStream) {
							await expected.testStream(header, stream, expected);
						} else {
							await defaultTestStream(header, stream, expected, projectPath);
						}
					}
				} catch (err) {
					reject(err);
				}
				next();
			},
		);
		extract.once('finish', () => {
			resolve(foundFiles);
		});
		sourceTarStream.on('error', reject);
		sourceTarStream.pipe(extract);
	});

	expect(found).to.deep.equal(
		_.mapValues(expectedFiles, v => _.omit(v, 'testStream', 'contents')),
	);
}

/** Check that a tar stream entry matches the project contents in the filesystem */
async function defaultTestStream(
	header: tar.Headers,
	stream: Readable,
	expected: ExpectedTarStreamFile | undefined,
	projectPath: string,
): Promise<void> {
	let expectedContents: Buffer | undefined;
	if (expected?.contents) {
		expectedContents = Buffer.from(expected.contents);
	}
	const [buf, buf2] = await Promise.all([
		streamToBuffer(stream),
		expectedContents ||
			fs.readFile(path.join(projectPath, PathUtils.toNativePath(header.name))),
	]);
	const msg = stripIndent`
		contents mismatch for tar stream entry "${header.name}"
		stream length=${buf.length}, filesystem length=${buf2.length}`;

	expect(buf.equals(buf2), msg).to.be.true;
}

/** Test a tar stream entry for the absence of Windows CRLF line breaks */
export async function expectStreamNoCRLF(
	_header: tar.Headers,
	stream: Readable,
): Promise<void> {
	const chai = await import('chai');
	const buf = await streamToBuffer(stream);
	await chai.expect(buf.includes('\r\n')).to.be.false;
}

/**
 * Common test logic for the 'build' and 'deploy' commands
 */
export async function testDockerBuildStream(o: {
	commandLine: string;
	dockerMock: DockerMock;
	expectedFilesByService: ExpectedTarStreamFilesByService;
	expectedQueryParamsByService: { [service: string]: string[][] };
	expectedResponseLines: string[];
	projectPath: string;
	responseCode: number;
	responseBody: string;
	services: string[]; // e.g. ['main'] or ['service1', 'service2']
}) {
	const expectedResponseLines = fillTemplateArray(o.expectedResponseLines, o);

	for (const service of o.services) {
		// tagPrefix is, for example, 'myApp' if the path is 'path/to/myApp'
		const tagPrefix = o.projectPath.split(path.sep).pop();
		const tag = `${tagPrefix}_${service}`;
		const expectedFiles = o.expectedFilesByService[service];
		const expectedQueryParams = fillTemplateArray(
			o.expectedQueryParamsByService[service],
			{ tag, ...o },
		);
		const projectPath =
			service === 'main' ? o.projectPath : path.join(o.projectPath, service);

		o.dockerMock.expectPostBuild({
			...o,
			checkURI: async (uri: string) => {
				const url = new URL(uri, 'http://test.net/');
				const queryParams = Array.from(url.searchParams.entries());
				expect(queryParams).to.have.deep.members(expectedQueryParams);
			},
			checkBuildRequestBody: (buildRequestBody: string) =>
				inspectTarStream(buildRequestBody, expectedFiles, projectPath),
			tag,
		});
		o.dockerMock.expectGetImages();
	}

	const { out, err } = await runCommand(o.commandLine);

	expect(err).to.be.empty;
	expect(
		cleanOutput(out).map(line => line.replace(/\s{2,}/g, ' ')),
	).to.include.members(expectedResponseLines);
}

/**
 * Common test logic for the 'push' command
 */
export async function testPushBuildStream(o: {
	commandLine: string;
	builderMock: BuilderMock;
	expectedFiles: ExpectedTarStreamFiles;
	expectedQueryParams: string[][];
	expectedResponseLines: string[];
	projectPath: string;
	responseCode: number;
	responseBody: string;
}) {
	const expectedQueryParams = fillTemplateArray(o.expectedQueryParams, o);
	const expectedResponseLines = fillTemplateArray(o.expectedResponseLines, o);

	o.builderMock.expectPostBuild({
		...o,
		checkURI: async (uri: string) => {
			const url = new URL(uri, 'http://test.net/');
			const queryParams = Array.from(url.searchParams.entries());
			expect(queryParams).to.have.deep.members(expectedQueryParams);
		},
		checkBuildRequestBody: (buildRequestBody: string) =>
			inspectTarStream(buildRequestBody, o.expectedFiles, o.projectPath),
	});

	const { out, err } = await runCommand(o.commandLine);

	expect(err).to.be.empty;
	expect(
		cleanOutput(out).map(line => line.replace(/\s{2,}/g, ' ')),
	).to.include.members(expectedResponseLines);
}
