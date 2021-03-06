/**
 * @license
 * Copyright 2019 Balena Ltd.
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
import BalenaSdk = require('balena-sdk');
import Bluebird = require('bluebird');
import { stripIndent } from 'common-tags';
import * as _ from 'lodash';
import * as path from 'path';

import { ExpectedError } from '../../errors';
import * as cf from '../../utils/common-flags';
import { getBalenaSdk } from '../../utils/lazy';
import { CommandHelp } from '../../utils/oclif-utils';

const BOOT_PARTITION = 1;
const CONNECTIONS_FOLDER = '/system-connections';

interface FlagsDef {
	advanced?: boolean;
	app?: string;
	application?: string;
	config?: string;
	'config-app-update-poll-interval'?: number;
	'config-network'?: string;
	'config-wifi-key'?: string;
	'config-wifi-ssid'?: string;
	device?: string; // device UUID
	'device-api-key'?: string;
	'device-type'?: string;
	help?: void;
	version?: string;
	'system-connection': string[];
}

interface ArgsDef {
	image: string;
}

interface DeferredDevice extends BalenaSdk.Device {
	belongs_to__application: BalenaSdk.PineDeferred;
}

interface Answers {
	appUpdatePollInterval: number; // in minutes
	deviceType: string; // e.g. "raspberrypi3"
	network: 'ethernet' | 'wifi';
	version: string; // e.g. "2.32.0+rev1"
	wifiSsid?: string;
	wifiKey?: string;
}

const deviceApiKeyDeprecationMsg = stripIndent`
	The --device-api-key option is deprecated and will be removed in a future release.
	A suitable key is automatically generated or fetched if this option is omitted.`;

export default class OsConfigureCmd extends Command {
	public static description = stripIndent`
		Configure a previously downloaded balenaOS image.

		Configure a previously downloaded balenaOS image for a specific device type or
		balena application.

		Configuration settings such as WiFi authentication will be taken from the
		following sources, in precedence order:
		1. Command-line options like \`--config-wifi-ssid\`
		2. A given \`config.json\` file specified with the \`--config\` option.
		3. User input through interactive prompts (text menus).

		The --device-type option may be used to override the application's default
		device type, in case of an application with mixed device types.

		The --system-connection (-c) option can be used to inject NetworkManager connection
		profiles for additional network interfaces, such as cellular/GSM or additional
		WiFi or ethernet connections. This option may be passed multiple times in case there
		are multiple files to inject. See connection profile examples and reference at:
		https://www.balena.io/docs/reference/OS/network/2.x/
		https://developer.gnome.org/NetworkManager/stable/nm-settings.html

		${deviceApiKeyDeprecationMsg.split('\n').join('\n\t\t')}
	`;
	public static examples = [
		'$ balena os configure ../path/rpi3.img --device 7cf02a6',
		'$ balena os configure ../path/rpi3.img --device 7cf02a6 --device-api-key <existingDeviceKey>',
		'$ balena os configure ../path/rpi3.img --app MyApp',
		'$ balena os configure ../path/rpi3.img --app MyApp --version 2.12.7',
		'$ balena os configure ../path/rpi3.img --app MyFinApp --device-type raspberrypi3',
		'$ balena os configure ../path/rpi3.img --app MyFinApp --device-type raspberrypi3 --config myWifiConfig.json',
	];

	public static args = [
		{
			name: 'image',
			required: true,
			description: 'path to a balenaOS image file, e.g. "rpi3.img"',
		},
	];

	// hardcoded 'os configure' to avoid oclif's 'os:configure' topic syntax
	public static usage =
		'os configure ' +
		new CommandHelp({ args: OsConfigureCmd.args }).defaultUsage();

	public static flags: flags.Input<FlagsDef> = {
		advanced: flags.boolean({
			char: 'v',
			description:
				'ask advanced configuration questions (when in interactive mode)',
		}),
		app: flags.string({
			description: "same as '--application'",
			exclusive: ['application', 'device'],
		}),
		application: { exclusive: ['app', 'device'], ...cf.application },
		config: flags.string({
			description:
				'path to a pre-generated config.json file to be injected in the OS image',
		}),
		'config-app-update-poll-interval': flags.integer({
			description:
				'interval (in minutes) for the on-device balena supervisor periodic app update check',
		}),
		'config-network': flags.string({
			description: 'device network type (non-interactive configuration)',
			options: ['ethernet', 'wifi'],
		}),
		'config-wifi-key': flags.string({
			description: 'WiFi key (password) (non-interactive configuration)',
		}),
		'config-wifi-ssid': flags.string({
			description: 'WiFi SSID (network name) (non-interactive configuration)',
		}),
		device: { exclusive: ['app', 'application'], ...cf.device },
		'device-api-key': flags.string({
			char: 'k',
			description:
				'custom device API key (DEPRECATED and only supported with balenaOS 2.0.3+)',
		}),
		'device-type': flags.string({
			description:
				'device type slug (e.g. "raspberrypi3") to override the application device type',
		}),
		help: cf.help,
		version: flags.string({
			description: 'balenaOS version, for example "2.32.0" or "2.44.0+rev1"',
		}),
		'system-connection': flags.string({
			multiple: true,
			char: 'c',
			required: false,
			description:
				"paths to local files to place into the 'system-connections' directory",
		}),
	};

	public async run() {
		const { args: params, flags: options } = this.parse<FlagsDef, ArgsDef>(
			OsConfigureCmd,
		);
		// Prefer options.application over options.app
		options.application = options.application || options.app;
		options.app = undefined;

		await validateOptions(options);

		const devInit = await import('balena-device-init');
		const fs = await import('mz/fs');
		const { generateDeviceConfig, generateApplicationConfig } = await import(
			'../../utils/config'
		);
		const helpers = await import('../../utils/helpers');
		const imagefs = await require('resin-image-fs');
		let app: BalenaSdk.Application | undefined;
		let device: BalenaSdk.Device | undefined;
		let deviceTypeSlug: string;

		const balena = getBalenaSdk();
		if (options.device) {
			device = await balena.models['device'].get(options.device);
			deviceTypeSlug = device.device_type;
		} else {
			app = await balena.models['application'].get(options.application!);
			await checkDeviceTypeCompatibility(balena, options, app);
			deviceTypeSlug = options['device-type'] || app.device_type;
		}

		const deviceTypeManifest = await helpers.getManifest(
			params.image,
			deviceTypeSlug,
		);

		let configJson: import('../../utils/config').ImgConfig | undefined;
		if (options.config) {
			const rawConfig = await fs.readFile(options.config, 'utf8');
			configJson = JSON.parse(rawConfig);
		}

		const answers: Answers = await askQuestionsForDeviceType(
			deviceTypeManifest,
			options,
			configJson,
		);
		if (options.application) {
			answers.deviceType = deviceTypeSlug;
		}
		answers.version =
			options.version ||
			(await getOsVersionFromImage(params.image, deviceTypeManifest, devInit));

		if (_.isEmpty(configJson)) {
			if (device) {
				configJson = await generateDeviceConfig(
					device as DeferredDevice,
					options['device-api-key'],
					answers,
				);
			} else {
				configJson = await generateApplicationConfig(app!, answers);
			}
		}

		console.info('Configuring operating system image');

		const image = params.image;
		await helpers.osProgressHandler(
			await devInit.configure(
				image,
				deviceTypeManifest,
				configJson || {},
				answers,
			),
		);

		if (options['system-connection']) {
			const files = await Bluebird.map(
				options['system-connection'],
				async filePath => {
					const content = await fs.readFile(filePath, 'utf8');
					const name = path.basename(filePath);

					return {
						name,
						content,
					};
				},
			);

			await Bluebird.each(files, async ({ name, content }) => {
				await imagefs.writeFile(
					{
						image,
						partition: BOOT_PARTITION,
						path: path.join(CONNECTIONS_FOLDER, name),
					},
					content,
				);
				console.info(`Copied system-connection file: ${name}`);
			});
		}
	}
}

async function validateOptions(options: FlagsDef) {
	if (process.platform === 'win32') {
		throw new ExpectedError(stripIndent`
			Unsupported platform error: the 'balena os configure' command currently requires
			the Windows Subsystem for Linux in order to run on Windows. It was tested with
			the Ubuntu 18.04 distribution from the Microsoft Store. With WSL, a balena CLI
			release for Linux (rather than Windows) should be installed: for example, the
			standalone zip package for Linux. (It is possible to have both a Windows CLI
			release and a Linux CLI release installed simultaneously.) For more information
			on WSL and the balena CLI installation options, please check:
			- https://docs.microsoft.com/en-us/windows/wsl/about
			- https://github.com/balena-io/balena-cli/blob/master/INSTALL.md
		`);
	}
	// The 'device' and 'application' options are declared "exclusive" in the oclif
	// flag definitions above, so oclif will enforce that they are not both used together.
	if (!options.device && !options.application) {
		throw new ExpectedError(
			"Either the '--device' or the '--application' option must be provided",
		);
	}
	if (!options.application && options['device-type']) {
		throw new ExpectedError(
			"The '--device-type' option can only be used in conjunction with the '--application' option",
		);
	}
	if (options['device-api-key']) {
		console.error(stripIndent`
			-------------------------------------------------------------------------------------------
			Warning: ${deviceApiKeyDeprecationMsg.split('\n').join('\n\t\t\t')}
			-------------------------------------------------------------------------------------------
		`);
	}
	const { checkLoggedIn } = await import('../../utils/patterns');
	await checkLoggedIn();
}

/**
 * Wrapper around balena-device-init.getImageOsVersion(). Throws ExpectedError
 * if the OS image could not be read or the OS version could not be extracted
 * from it.
 * @param imagePath Local filesystem path to a balenaOS image file
 * @param deviceTypeManifest Device type manifest object
 */
async function getOsVersionFromImage(
	imagePath: string,
	deviceTypeManifest: BalenaSdk.DeviceType,
	devInit: typeof import('balena-device-init'),
): Promise<string> {
	const osVersion = await devInit.getImageOsVersion(
		imagePath,
		deviceTypeManifest,
	);
	if (!osVersion) {
		throw new ExpectedError(stripIndent`
			Could not read OS version from the image. Please specify the balenaOS
			version manually with the --version command-line option.`);
	}
	return osVersion;
}

/**
 * Check that options['device-type'], e.g. 'raspberrypi3', is compatible with
 * app.device_type, e.g. 'raspberry-pi2'. Throws ExpectedError if they are not
 * compatible.
 * @param sdk Balena Node SDK instance
 * @param options oclif command-line options object
 * @param app Balena SDK Application model object
 */
async function checkDeviceTypeCompatibility(
	sdk: BalenaSdk.BalenaSDK,
	options: FlagsDef,
	app: BalenaSdk.Application,
) {
	if (options['device-type']) {
		const [appDeviceType, optionDeviceType] = await Promise.all([
			sdk.models.device.getManifestBySlug(app.device_type),
			sdk.models.device.getManifestBySlug(options['device-type']),
		]);
		const helpers = await import('../../utils/helpers');
		if (!helpers.areDeviceTypesCompatible(appDeviceType, optionDeviceType)) {
			throw new ExpectedError(
				`Device type ${options['device-type']} is incompatible with application ${options.application}`,
			);
		}
	}
}

/**
 * Check if the given options or configJson objects (in this order) contain
 * the answers to some configuration questions, and interactively ask the
 * user the questions for which answers are missing. Questions such as:
 *
 *     ? Network Connection (Use arrow keys)
 *       ethernet
 *     ❯ wifi
 *     ? Network Connection wifi
 *     ? Wifi SSID i-ssid
 *     ? Wifi Passphrase [input is hidden]
 *
 * The questions are extracted from the given deviceType "manifest".
 */
async function askQuestionsForDeviceType(
	deviceType: BalenaSdk.DeviceType,
	options: FlagsDef,
	configJson?: import('../../utils/config').ImgConfig,
): Promise<Answers> {
	const form = await import('resin-cli-form');
	const helpers = await import('../../utils/helpers');
	const answerSources: any[] = [camelifyConfigOptions(options)];
	const defaultAnswers: Partial<Answers> = {};
	const questions: any = deviceType.options;
	let extraOpts: { override: object } | undefined;

	if (!_.isEmpty(configJson)) {
		answerSources.push(configJson);
	}

	if (!options.advanced) {
		const advancedGroup: any = _.find(questions, {
			name: 'advanced',
			isGroup: true,
		});
		if (!_.isEmpty(advancedGroup)) {
			answerSources.push(helpers.getGroupDefaults(advancedGroup));
		}
	}

	for (const questionName of getQuestionNames(deviceType)) {
		for (const answerSource of answerSources) {
			if (answerSource[questionName] != null) {
				defaultAnswers[questionName] = answerSource[questionName];
				break;
			}
		}
	}
	if (
		!defaultAnswers.network &&
		(defaultAnswers.wifiSsid || defaultAnswers.wifiKey)
	) {
		defaultAnswers.network = 'wifi';
	}

	if (!_.isEmpty(defaultAnswers)) {
		extraOpts = { override: defaultAnswers };
	}

	return form.run(questions, extraOpts);
}

/**
 * Given a deviceType "manifest" containing "options" properties, return an
 * array of "question names" as in the following example.
 *
 * @param deviceType Device type "manifest", for example:
 *    {   "slug": "raspberrypi3",
 *        "options": [{
 *                "options": [ {
 *                        "name": "network",
 *                        "choices": ["ethernet", "wifi"],
 *                        ... }, {
 *                        "name": "wifiSsid",
 *                        "type": "text",
 *                        ... }, {
 *                "options": [ {
 *                        "name": "appUpdatePollInterval",
 *                        "default": 10,
 *                        ...
 * @return Array of question names, for example:
 *     [ 'network', 'wifiSsid', 'wifiKey', 'appUpdatePollInterval' ]
 */
function getQuestionNames(
	deviceType: BalenaSdk.DeviceType,
): Array<keyof Answers> {
	const questionNames: string[] = _.chain(deviceType.options)
		.flatMap(
			(group: BalenaSdk.DeviceTypeOptions) =>
				(group.isGroup && group.options) || [],
		)
		.map((groupOption: BalenaSdk.DeviceTypeOptionsGroup) => groupOption.name)
		.filter()
		.value();
	return questionNames as Array<keyof Answers>;
}

/**
 * Create and return a new object with the key-value pairs from the input object,
 * renaming keys that start with the 'config-' prefix as follows:
 * Sample input:
 *     { app: 'foo', 'config-wifi-key': 'mykey', 'config-wifi-ssid': 'myssid' }
 * Output:
 *     { app: 'foo', wifiKey: 'mykey', wifiSsid: 'myssid' }
 */
function camelifyConfigOptions(options: FlagsDef): { [key: string]: any } {
	return _.mapKeys(options, (_value, key) => {
		if (key.startsWith('config-')) {
			return key
				.substring('config-'.length)
				.replace(/-[a-z]/g, match => match.substring(1).toUpperCase());
		}
		return key;
	});
}
