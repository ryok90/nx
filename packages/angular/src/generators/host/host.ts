import {
  formatFiles,
  getProjects,
  joinPathFragments,
  readProjectConfiguration,
  runTasksInSerial,
  Tree,
  updateProjectConfiguration,
} from '@nx/devkit';
import {
  determineProjectNameAndRootOptions,
  ensureRootProjectName,
} from '@nx/devkit/src/generators/project-name-and-root-utils';
import { isValidVariable } from '@nx/js';
import { assertNotUsingTsSolutionSetup } from '@nx/js/src/utils/typescript/ts-solution-setup';
import { E2eTestRunner } from '../../utils/test-runners';
import applicationGenerator from '../application/application';
import remoteGenerator from '../remote/remote';
import { setupMf } from '../setup-mf/setup-mf';
import { addMfEnvToTargetDefaultInputs } from '../utils/add-mf-env-to-inputs';
import { updateSsrSetup } from './lib';
import type { Schema } from './schema';
import { assertRspackIsCSR } from '../utils/assert-mf-utils';
import convertToRspack from '../convert-to-rspack/convert-to-rspack';

export async function host(tree: Tree, schema: Schema) {
  assertNotUsingTsSolutionSetup(tree, 'angular', 'host');
  // TODO: Replace with Rspack when confidence is high enough
  schema.bundler ??= 'webpack';
  const isRspack = schema.bundler === 'rspack';
  assertRspackIsCSR(
    schema.bundler,
    schema.ssr ?? false,
    schema.serverRouting ?? false
  );

  const { typescriptConfiguration = true, ...options }: Schema = schema;
  options.standalone = options.standalone ?? true;

  const projects = getProjects(tree);

  const remotesToGenerate: string[] = [];
  const remotesToIntegrate: string[] = [];

  // Check to see if remotes are provided and also check if --dynamic is provided
  // if both are check that the remotes are valid names else throw an error.
  if (options.dynamic && options.remotes?.length > 0) {
    options.remotes.forEach((remote) => {
      const isValidRemote = isValidVariable(remote);
      if (!isValidRemote.isValid) {
        throw new Error(
          `Invalid remote name provided: ${remote}. ${isValidRemote.message}`
        );
      }
    });
  }

  if (options.remotes && options.remotes.length > 0) {
    options.remotes.forEach((remote) => {
      if (!projects.has(remote)) {
        remotesToGenerate.push(remote);
      } else {
        remotesToIntegrate.push(remote);
      }
    });
  }

  await ensureRootProjectName(options, 'application');
  const { projectName: hostProjectName, projectRoot: appRoot } =
    await determineProjectNameAndRootOptions(tree, {
      name: options.name,
      projectType: 'application',
      directory: options.directory,
    });

  const appInstallTask = await applicationGenerator(tree, {
    ...options,
    standalone: options.standalone,
    routing: true,
    port: 4200,
    skipFormat: true,
    bundler: 'webpack',
  });

  const skipE2E =
    !options.e2eTestRunner || options.e2eTestRunner === E2eTestRunner.None;
  await setupMf(tree, {
    appName: hostProjectName,
    mfType: 'host',
    routing: true,
    port: 4200,
    remotes: remotesToIntegrate ?? [],
    federationType: options.dynamic ? 'dynamic' : 'static',
    skipPackageJson: options.skipPackageJson,
    skipFormat: true,
    skipE2E,
    e2eProjectName: skipE2E ? undefined : `${hostProjectName}-e2e`,
    prefix: options.prefix,
    typescriptConfiguration,
    standalone: options.standalone,
    setParserOptionsProject: options.setParserOptionsProject,
  });

  let installTasks = [appInstallTask];
  if (options.ssr) {
    let ssrInstallTask = await updateSsrSetup(
      tree,
      options,
      hostProjectName,
      typescriptConfiguration
    );
    installTasks.push(ssrInstallTask);
  }

  for (let i = 0; i < remotesToGenerate.length; i++) {
    const remote = remotesToGenerate[i];
    const remoteDirectory = options.directory
      ? joinPathFragments(options.directory, '..', remote)
      : appRoot === '.'
      ? remote
      : joinPathFragments(appRoot, '..', remote);
    await remoteGenerator(tree, {
      ...options,
      name: remote,
      directory: remoteDirectory,
      host: hostProjectName,
      port: isRspack ? 4200 + i + 1 : undefined,
      skipFormat: true,
      standalone: options.standalone,
      typescriptConfiguration,
    });
  }

  addMfEnvToTargetDefaultInputs(tree);

  if (isRspack) {
    await convertToRspack(tree, {
      project: hostProjectName,
      skipInstall: options.skipPackageJson,
      skipFormat: true,
    });
  }

  const project = readProjectConfiguration(tree, hostProjectName);
  project.targets.serve ??= {};
  project.targets.serve.options ??= {};
  project.targets.serve.options.port = 4200;
  updateProjectConfiguration(tree, hostProjectName, project);

  if (!options.skipFormat) {
    await formatFiles(tree);
  }

  return runTasksInSerial(...installTasks);
}

export default host;
