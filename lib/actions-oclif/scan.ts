/**
 * @license
 * Copyright 2020 Balena Ltd.
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

import { Command, flags } from '@oclif/command';
import { LocalBalenaOsDevice } from 'balena-sync';
import { stripIndent } from 'common-tags';
import * as cf from '../utils/common-flags';

interface FlagsDef {
	verbose: boolean;
	timeout?: number;
	help: void;
}

export default class ScanCmd extends Command {
	public static description = stripIndent`
		Scan for balenaOS devices in your local network;
`;

	public static examples = [
		'$ balena scan',
		'$ balena scan --timeout 120',
		'$ balena scan --verbose',
	];

	public static usage = 'scan';

	public static flags: flags.Input<FlagsDef> = {
		verbose: flags.boolean({
			char: 'v',
			default: false,
			description: 'display full info',
		}),
		timeout: flags.integer({
			char: 't',
			description: 'scan timeout in seconds',
		}),
		help: cf.help,
	};

	public async run() {
		const Bluebird = await import('bluebird');
		const _ = await import('lodash');
		const { SpinnerPromise } = await import('resin-cli-visuals');
		const { discover } = await import('balena-sync');
		const prettyjson = await import('prettyjson');
		const { exitWithExpectedError } = await import('../utils/patterns');
		const { dockerPort, dockerTimeout } = await import(
			'../actions/local/common'
		);
		const dockerUtils = await import('../utils/docker');

		const { flags: options } = this.parse<FlagsDef, {}>(ScanCmd);

		const discoverTimeout =
			options.timeout != null ? options.timeout * 1000 : undefined;

		// Find active local devices
		const activeLocalDevices: LocalBalenaOsDevice[] = await new SpinnerPromise({
			promise: discover.discoverLocalBalenaOsDevices(discoverTimeout),
			startMessage: 'Scanning for local balenaOS devices..',
			stopMessage: 'Reporting scan results',
		}).filter(({ address }: { address: string }) => {
			return Bluebird.try(() => {
				const docker = dockerUtils.createClient({
					host: address,
					port: dockerPort,
					timeout: dockerTimeout,
				});
				return docker.pingAsync();
			})
				.return(true)
				.catchReturn(false);
		});

		// Exit with message if no devices found
		if (_.isEmpty(activeLocalDevices)) {
			return exitWithExpectedError(
				process.platform === 'win32'
					? ScanCmd.noDevicesFoundMessage + ScanCmd.windowsTipMessage
					: ScanCmd.noDevicesFoundMessage,
			);
		}

		// Query devices for info
		const devicesInfo = await Bluebird.map(
			activeLocalDevices,
			({ host, address }) => {
				const docker = dockerUtils.createClient({
					host: address,
					port: dockerPort,
					timeout: dockerTimeout,
				});
				return Bluebird.props({
					host,
					address,
					dockerInfo: docker
						.infoAsync()
						.catchReturn('Could not get Docker info'),
					dockerVersion: docker
						.versionAsync()
						.catchReturn('Could not get Docker version'),
				});
			},
		);

		// Reduce properties if not --verbose
		if (!options.verbose) {
			devicesInfo.forEach((d: any) => {
				d.dockerInfo = _.isObject(d.dockerInfo)
					? _.pick(d.dockerInfo, ScanCmd.dockerInfoProperties)
					: d.dockerInfo;
				d.dockerVersion = _.isObject(d.dockerVersion)
					? _.pick(d.dockerVersion, ScanCmd.dockerVersionProperties)
					: d.dockerVersion;
			});
		}

		// Output results
		console.log(prettyjson.render(devicesInfo, { noColor: true }));
	}

	protected static dockerInfoProperties = [
		'Containers',
		'ContainersRunning',
		'ContainersPaused',
		'ContainersStopped',
		'Images',
		'Driver',
		'SystemTime',
		'KernelVersion',
		'OperatingSystem',
		'Architecture',
	];

	protected static dockerVersionProperties = ['Version', 'ApiVersion'];

	protected static noDevicesFoundMessage =
		'Could not find any balenaOS devices on the local network.';

	protected static windowsTipMessage = `

Note for Windows users:
  The 'scan' command relies on the Bonjour service. Check whether Bonjour is
  installed (Control Panel > Programs and Features). If not, you can download
  Bonjour for Windows (included with Bonjour Print Services) from here:
  https://support.apple.com/kb/DL999

  After installing Bonjour, restart your PC and run the 'balena scan' command
  again.`;
}
