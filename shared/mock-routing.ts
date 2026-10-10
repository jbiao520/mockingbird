import type { Dependency, MockRule, MockService } from './types';

// A configuration key is shared by every call routed through that base URL,
// including calls declared in different workflows. Never use a dependency ID.
export function dependencyService(dep:Pick<Dependency,'configKey'|'originalBase'>):MockService|undefined{
  if(!dep.originalBase)return;
  const base=new URL(dep.originalBase);
  return{
    namespace:dep.configKey?'config-'+encodeURIComponent(dep.configKey):'origin-'+encodeURIComponent(base.origin),
    basePath:base.pathname.replace(/\/+$/,'')
  };
}
export function mockBasePath(service:MockService|undefined){
  return service?`/__mockingbird/${service.namespace}${service.basePath}`:'';
}
export function mockRequestPath(rule:Pick<MockRule,'service'|'path'>){
  return mockBasePath(rule.service)+rule.path;
}
export function mockBaseUrl(dep:Pick<Dependency,'configKey'|'originalBase'>,port:number){
  return `http://127.0.0.1:${port}${mockBasePath(dependencyService(dep))}`;
}
