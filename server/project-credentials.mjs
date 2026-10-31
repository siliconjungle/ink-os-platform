import { AppEnvironment } from './app-environment.mjs';

const fail = (status, message) => { throw Object.assign(Error(message), { status }); };
export function githubDestination(project) {
  if (project.source.provider !== 'github') fail(409, 'Configure this project for GitHub first.');
  const { owner, repository } = project.source.github;
  return owner.toLowerCase() + '/' + repository.toLowerCase();
}

export class ProjectCredentials {
  constructor(directory, key) {
    this.store = new AppEnvironment(directory, key, { filename: 'project-credentials.json', domain: 'ink-os-project-credentials-v1' });
  }
  async open() { await this.store.open(); return this; }
  status(project) {
    if (!this.store.records[project.id]) return { configured: false };
    const values = this.store.values(project.id);
    return {
      configured: true,
      matchesProject: project.source.provider === 'github' && values.DESTINATION === githubDestination(project),
      updatedAt: this.store.records[project.id].metadata.TOKEN.updatedAt,
    };
  }
  async set(project, token) {
    const destination = githubDestination(project);
    if (typeof token !== 'string' || token.length < 20 || token.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(token)) fail(400, 'Provide a GitHub access token through the private credentials endpoint.');
    await this.store.mutate(project.id, { TOKEN: token, DESTINATION: destination });
    return this.status(project);
  }
  async remove(project) { await this.store.remove(project.id); return { configured: false }; }
  token(project) {
    if (!this.status(project).matchesProject) fail(409, 'Set GitHub credentials for this project and destination first.');
    return this.store.values(project.id).TOKEN;
  }
}
