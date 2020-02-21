import * as core from '@actions/core'
import * as fs from 'fs'
import * as gitAuthHelper from '../lib/git-auth-helper'
import * as io from '@actions/io'
import * as os from 'os'
import * as path from 'path'
import * as stateHelper from '../lib/state-helper'
import {IGitCommandManager} from '../lib/git-command-manager'
import {IGitSourceSettings} from '../lib/git-source-settings'

const isWindows = process.platform === 'win32'
const testWorkspace = path.join(__dirname, '_temp', 'git-auth-helper')
const originalRunnerTemp = process.env['RUNNER_TEMP']
let workspace: string
let gitConfigPath: string
let runnerTemp: string
let git: IGitCommandManager
let settings: IGitSourceSettings
let sshPath: string

describe('git-auth-helper tests', () => {
  beforeAll(async () => {
    // SSH
    sshPath = await io.which('ssh')

    // Clear test workspace
    await io.rmRF(testWorkspace)
  })

  beforeEach(() => {
    // Mock state-helper
    jest.spyOn(stateHelper, 'setSshKeyPath').mockImplementation(jest.fn())
    jest
      .spyOn(stateHelper, 'setSshKnownHostsPath')
      .mockImplementation(jest.fn())

    // Mock setSecret
    jest.spyOn(core, 'setSecret').mockImplementation((secret: string) => {})
  })

  afterEach(() => {
    // Unregister mocks
    jest.restoreAllMocks()
  })

  afterAll(() => {
    // Restore RUNNER_TEMP
    delete process.env['RUNNER_TEMP']
    if (originalRunnerTemp) {
      process.env['RUNNER_TEMP'] = originalRunnerTemp
    }
  })

  const configuresAuthHeader = 'configures auth header'
  it(configuresAuthHeader, async () => {
    // Arrange
    await setup(configuresAuthHeader)
    expect(settings.authToken).toBeTruthy() // sanity check
    const authHelper = gitAuthHelper.createAuthHelper(git, settings)

    // Act
    await authHelper.configureAuth()

    // Assert config
    const configContent = (await fs.promises.readFile(gitConfigPath)).toString()
    const basicCredential = Buffer.from(
      `x-access-token:${settings.authToken}`,
      'utf8'
    ).toString('base64')
    expect(
      configContent.indexOf(
        `http.https://github.com/.extraheader AUTHORIZATION: basic ${basicCredential}`
      )
    ).toBeGreaterThanOrEqual(0)
  })

  const configuresAuthHeaderEvenWhenPersistCredentialsFalse =
    'configures auth header even when persist credentials false'
  it(configuresAuthHeaderEvenWhenPersistCredentialsFalse, async () => {
    // Arrange
    await setup(configuresAuthHeaderEvenWhenPersistCredentialsFalse)
    expect(settings.authToken).toBeTruthy() // sanity check
    settings.persistCredentials = false
    const authHelper = gitAuthHelper.createAuthHelper(git, settings)

    // Act
    await authHelper.configureAuth()

    // Assert config
    const configContent = (await fs.promises.readFile(gitConfigPath)).toString()
    expect(
      configContent.indexOf(
        `http.https://github.com/.extraheader AUTHORIZATION`
      )
    ).toBeGreaterThanOrEqual(0)
  })

  const copiesUserKnownHosts = 'copies user known hosts'
  it(copiesUserKnownHosts, async () => {
    if (!sshPath) {
      process.stdout.write(
        `Skipped test "${copiesUserKnownHosts}". Executable 'ssh' not found in the PATH.\n`
      )
      return
    }

    // Arange
    await setup(copiesUserKnownHosts)
    expect(settings.sshKey).toBeTruthy() // sanity check

    // Mock fs.promises.readFile
    const realReadFile = fs.promises.readFile
    jest.spyOn(fs.promises, 'readFile').mockImplementation(
      async (file: any, options: any): Promise<Buffer> => {
        const userKnownHostsPath = path.join(
          os.homedir(),
          '.ssh',
          'known_hosts'
        )
        if (file === userKnownHostsPath) {
          return Buffer.from('some-domain.com ssh-rsa ABCDEF')
        }

        return await realReadFile(file, options)
      }
    )

    // Act
    const authHelper = gitAuthHelper.createAuthHelper(git, settings)
    await authHelper.configureAuth()

    // Assert known hosts
    const actualSshKnownHostsPath = await getActualSshKnownHostsPath()
    const actualSshKnownHostsContent = (
      await fs.promises.readFile(actualSshKnownHostsPath)
    ).toString()
    expect(actualSshKnownHostsContent).toMatch(
      /some-domain\.com ssh-rsa ABCDEF/
    )
    expect(actualSshKnownHostsContent).toMatch(/github\.com ssh-rsa AAAAB3N/)
  })

  const registersBasicCredentialAsSecret =
    'registers basic credential as secret'
  it(registersBasicCredentialAsSecret, async () => {
    // Arrange
    await setup(registersBasicCredentialAsSecret)
    expect(settings.authToken).toBeTruthy() // sanity check
    const authHelper = gitAuthHelper.createAuthHelper(git, settings)

    // Act
    await authHelper.configureAuth()

    // Assert secret
    const setSecretSpy = core.setSecret as jest.Mock<any, any>
    expect(setSecretSpy).toHaveBeenCalledTimes(1)
    const expectedSecret = Buffer.from(
      `x-access-token:${settings.authToken}`,
      'utf8'
    ).toString('base64')
    expect(setSecretSpy).toHaveBeenCalledWith(expectedSecret)
  })

  const removesSshCommand = 'removes SSH command'
  it(removesSshCommand, async () => {
    if (!sshPath) {
      process.stdout.write(
        `Skipped test "${removesSshCommand}". Executable 'ssh' not found in the PATH.\n`
      )
      return
    }

    // Arrange
    await setup(removesSshCommand)
    const authHelper = gitAuthHelper.createAuthHelper(git, settings)
    await authHelper.configureAuth()
    let gitConfigContent = (
      await fs.promises.readFile(gitConfigPath)
    ).toString()
    expect(gitConfigContent.indexOf('core.sshCommand')).toBeGreaterThanOrEqual(
      0
    ) // sanity check
    const actualKeyPath = await getActualSshKeyPath()
    expect(actualKeyPath).toBeTruthy()
    await fs.promises.stat(actualKeyPath)
    const actualKnownHostsPath = await getActualSshKnownHostsPath()
    expect(actualKnownHostsPath).toBeTruthy()
    await fs.promises.stat(actualKnownHostsPath)

    // Act
    await authHelper.removeAuth()

    // Assert git config
    gitConfigContent = (await fs.promises.readFile(gitConfigPath)).toString()
    expect(gitConfigContent.indexOf('core.sshCommand')).toBeLessThan(0)

    // Assert SSH key file
    try {
      await fs.promises.stat(actualKeyPath)
      throw new Error('SSH key should have been deleted')
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err
      }
    }

    // Assert known hosts file
    try {
      await fs.promises.stat(actualKnownHostsPath)
      throw new Error('SSH known hosts should have been deleted')
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err
      }
    }
  })

  const removesToken = 'removes token'
  it(removesToken, async () => {
    // Arrange
    await setup(removesToken)
    const authHelper = gitAuthHelper.createAuthHelper(git, settings)
    await authHelper.configureAuth()
    let gitConfigContent = (
      await fs.promises.readFile(gitConfigPath)
    ).toString()
    expect(gitConfigContent.indexOf('http.')).toBeGreaterThanOrEqual(0) // sanity check

    // Act
    await authHelper.removeAuth()

    // Assert git config
    gitConfigContent = (await fs.promises.readFile(gitConfigPath)).toString()
    expect(gitConfigContent.indexOf('http.')).toBeLessThan(0)
  })

  const setsSshCommandEnvVarWhenPersistCredentialsFalse =
    'sets SSH command env var when persist-credentials false'
  it(setsSshCommandEnvVarWhenPersistCredentialsFalse, async () => {
    if (!sshPath) {
      process.stdout.write(
        `Skipped test "${setsSshCommandEnvVarWhenPersistCredentialsFalse}". Executable 'ssh' not found in the PATH.\n`
      )
      return
    }

    // Arrange
    await setup(setsSshCommandEnvVarWhenPersistCredentialsFalse)
    settings.persistCredentials = false
    const authHelper = gitAuthHelper.createAuthHelper(git, settings)

    // Act
    await authHelper.configureAuth()

    // Assert git env var
    const actualKeyPath = await getActualSshKeyPath()
    const actualKnownHostsPath = await getActualSshKnownHostsPath()
    const expectedSshCommand = `"${sshPath}" -i "$RUNNER_TEMP/${path.basename(
      actualKeyPath
    )}" -o StrictHostKeyChecking=yes -o CheckHostIP=no -o "UserKnownHostsFile=$RUNNER_TEMP/${path.basename(
      actualKnownHostsPath
    )}"`
    expect(git.setEnvironmentVariable).toHaveBeenCalledWith(
      'GIT_SSH_COMMAND',
      expectedSshCommand
    )

    // Asserty git config
    const gitConfigLines = (await fs.promises.readFile(gitConfigPath))
      .toString()
      .split('\n')
      .filter(x => x)
    expect(gitConfigLines).toHaveLength(1)
    expect(gitConfigLines[0]).toMatch(/^http\./)
  })

  const setsSshCommandWhenPersistCredentialsTrue =
    'sets SSH command when persist-credentials true'
  it(setsSshCommandWhenPersistCredentialsTrue, async () => {
    if (!sshPath) {
      process.stdout.write(
        `Skipped test "${setsSshCommandWhenPersistCredentialsTrue}". Executable 'ssh' not found in the PATH.\n`
      )
      return
    }

    // Arrange
    await setup(setsSshCommandWhenPersistCredentialsTrue)
    const authHelper = gitAuthHelper.createAuthHelper(git, settings)

    // Act
    await authHelper.configureAuth()

    // Assert git env var
    const actualKeyPath = await getActualSshKeyPath()
    const actualKnownHostsPath = await getActualSshKnownHostsPath()
    const expectedSshCommand = `"${sshPath}" -i "$RUNNER_TEMP/${path.basename(
      actualKeyPath
    )}" -o StrictHostKeyChecking=yes -o CheckHostIP=no -o "UserKnownHostsFile=$RUNNER_TEMP/${path.basename(
      actualKnownHostsPath
    )}"`
    expect(git.setEnvironmentVariable).toHaveBeenCalledWith(
      'GIT_SSH_COMMAND',
      expectedSshCommand
    )

    // Asserty git config
    expect(git.config).toHaveBeenCalledWith(
      'core.sshCommand',
      expectedSshCommand
    )
  })

  const writesExplicitKnownHosts = 'writes explicit known hosts'
  it(writesExplicitKnownHosts, async () => {
    if (!sshPath) {
      process.stdout.write(
        `Skipped test "${writesExplicitKnownHosts}". Executable 'ssh' not found in the PATH.\n`
      )
      return
    }

    // Arrange
    await setup(writesExplicitKnownHosts)
    expect(settings.sshKey).toBeTruthy() // sanity check
    settings.sshKnownHosts = 'my-custom-host.com ssh-rsa ABC123'
    const authHelper = gitAuthHelper.createAuthHelper(git, settings)

    // Act
    await authHelper.configureAuth()

    // Assert known hosts
    const actualSshKnownHostsPath = await getActualSshKnownHostsPath()
    const actualSshKnownHostsContent = (
      await fs.promises.readFile(actualSshKnownHostsPath)
    ).toString()
    expect(actualSshKnownHostsContent).toMatch(
      /my-custom-host\.com ssh-rsa ABC123/
    )
    expect(actualSshKnownHostsContent).toMatch(/github\.com ssh-rsa AAAAB3N/)
  })

  const writesSshKeyAndImplicitKnownHosts =
    'writes SSH key and implicit known hosts'
  it(writesSshKeyAndImplicitKnownHosts, async () => {
    if (!sshPath) {
      process.stdout.write(
        `Skipped test "${writesSshKeyAndImplicitKnownHosts}". Executable 'ssh' not found in the PATH.\n`
      )
      return
    }

    // Arrange
    await setup(writesSshKeyAndImplicitKnownHosts)
    expect(settings.sshKey).toBeTruthy() // sanity check
    const authHelper = gitAuthHelper.createAuthHelper(git, settings)

    // Act
    await authHelper.configureAuth()

    // Assert SSH key
    const actualSshKeyPath = await getActualSshKeyPath()
    expect(actualSshKeyPath).toBeTruthy()
    const actualSshKeyContent = (
      await fs.promises.readFile(actualSshKeyPath)
    ).toString()
    expect(actualSshKeyContent).toBe(settings.sshKey + '\n')
    if (!isWindows) {
      expect((await fs.promises.stat(actualSshKeyPath)).mode & 0o777).toBe(
        0o600
      )
    }

    // Assert known hosts
    const actualSshKnownHostsPath = await getActualSshKnownHostsPath()
    const actualSshKnownHostsContent = (
      await fs.promises.readFile(actualSshKnownHostsPath)
    ).toString()
    expect(actualSshKnownHostsContent).toMatch(/github\.com ssh-rsa AAAAB3N/)
  })
})

async function setup(testName: string): Promise<void> {
  testName = testName.replace(/[^a-zA-Z0-9_]+/g, '-')

  // Directories
  workspace = path.join(testWorkspace, testName, 'workspace')
  runnerTemp = path.join(testWorkspace, testName, 'runner-temp')
  await fs.promises.mkdir(workspace, {recursive: true})
  await fs.promises.mkdir(runnerTemp, {recursive: true})
  process.env['RUNNER_TEMP'] = runnerTemp

  // Create git config
  gitConfigPath = path.join(workspace, '.git', 'config')
  await fs.promises.mkdir(path.join(workspace, '.git'), {recursive: true})
  await fs.promises.writeFile(path.join(workspace, '.git', 'config'), '')

  git = {
    branchDelete: jest.fn(),
    branchExists: jest.fn(),
    branchList: jest.fn(),
    checkout: jest.fn(),
    checkoutDetach: jest.fn(),
    config: jest.fn(async (key: string, value: string) => {
      await fs.promises.appendFile(gitConfigPath, `\n${key} ${value}`)
    }),
    configExists: jest.fn(
      async (key: string): Promise<boolean> => {
        const content = await fs.promises.readFile(gitConfigPath)
        const lines = content
          .toString()
          .split('\n')
          .filter(x => x)
        return lines.some(x => x.startsWith(key))
      }
    ),
    fetch: jest.fn(),
    getWorkingDirectory: jest.fn(() => workspace),
    init: jest.fn(),
    isDetached: jest.fn(),
    lfsFetch: jest.fn(),
    lfsInstall: jest.fn(),
    log1: jest.fn(),
    remoteAdd: jest.fn(),
    setEnvironmentVariable: jest.fn(),
    submoduleSync: jest.fn(),
    submoduleUpdate: jest.fn(),
    tagExists: jest.fn(),
    tryClean: jest.fn(),
    tryConfigUnset: jest.fn(
      async (key: string): Promise<boolean> => {
        let content = await fs.promises.readFile(gitConfigPath)
        let lines = content
          .toString()
          .split('\n')
          .filter(x => x)
          .filter(x => !x.startsWith(key))
        await fs.promises.writeFile(gitConfigPath, lines.join('\n'))
        return true
      }
    ),
    tryDisableAutomaticGarbageCollection: jest.fn(),
    tryGetFetchUrl: jest.fn(),
    tryReset: jest.fn()
  }

  settings = {
    authToken: 'some auth token',
    clean: true,
    commit: '',
    fetchDepth: 1,
    lfs: false,
    submodules: false,
    nestedSubmodules: false,
    persistCredentials: true,
    ref: 'refs/heads/master',
    repositoryName: 'my-repo',
    repositoryOwner: 'my-org',
    repositoryPath: '',
    sshKey: sshPath ? 'some ssh private key' : '',
    sshKnownHosts: '',
    sshStrict: true
  }
}

async function getActualSshKeyPath(): Promise<string> {
  let actualTempFiles = (await fs.promises.readdir(runnerTemp))
    .sort()
    .map(x => path.join(runnerTemp, x))
  if (actualTempFiles.length === 0) {
    return ''
  }

  expect(actualTempFiles).toHaveLength(2)
  expect(actualTempFiles[0].endsWith('_known_hosts')).toBeFalsy()
  return actualTempFiles[0]
}

async function getActualSshKnownHostsPath(): Promise<string> {
  let actualTempFiles = (await fs.promises.readdir(runnerTemp))
    .sort()
    .map(x => path.join(runnerTemp, x))
  if (actualTempFiles.length === 0) {
    return ''
  }

  expect(actualTempFiles).toHaveLength(2)
  expect(actualTempFiles[1].endsWith('_known_hosts')).toBeTruthy()
  expect(actualTempFiles[1].startsWith(actualTempFiles[0])).toBeTruthy()
  return actualTempFiles[1]
}
