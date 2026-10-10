export type HttpMethod = 'GET'|'POST'|'PUT'|'PATCH'|'DELETE'|'HEAD'|'OPTIONS';
export interface RequestTemplate { entryId:string;revision:string;method:HttpMethod;path:string;body?:unknown;headers:Record<string,string>;warnings:string[] }
export interface Evidence { file:string;line:number;snippet:string;kind:'static'|'manual'|'ai';note:string }
export interface JavaMethod { id:string;className:string;name:string;returnType:string;parameters:string;body:string;file:string;line:number;annotations:string;fields:Record<string,string>;start:number;end:number }
export interface Entry { id:string;method:HttpMethod;path:string;className:string;name:string;file:string;line:number;methodId:string }
export interface DependencyDraft { name:string;client:string;method:HttpMethod;path:string;originalBase:string;configKey:string;responseType:string;file:string;line:number;note:string;callChain:{file:string;line:number}[] }
export interface Dependency { id:string;name:string;client:string;method:HttpMethod;path:string;url:string;configKey?:string;originalBase?:string;sourceMethod:string;evidence:Evidence;status:'static'|'confirmed'|'unresolved';reason?:string;route:'real'|'mock';responseType?:string }
export interface Workflow { id:string;entry:Entry;methods:Array<Pick<JavaMethod,'id'|'className'|'name'|'file'|'line'>>;edges:{source:string;target:string;label?:string}[];dependencies:Dependency[];revision:string;analyzedAt:string;warnings:string[] }
export interface FileNode { name:string;path:string;directory:boolean;children?:FileNode[] }
export interface Project { id:string;name:string;path:string;build:'Maven'|'Gradle';javaVersion:string;modules:string[];files:FileNode[];entries:Entry[];indexedAt:string;revision:string;warnings:string[];fileCount:number }
export interface RuleEvidence { file:string;line:number;reason:string }
export interface MockService { namespace:string;basePath:string }
export interface BehaviorRequest { path:string;headers:Record<string,string>;body?:unknown }
export interface RequestCondition { source:'body'|'header'|'query'|'path';field:string;operator:'eq'|'contains'|'regex'|'exists'|'missing'|'gt'|'gte'|'lt'|'lte';value?:unknown }
export type FieldSource = { kind:'request';source:RequestCondition['source'];field:string;fallback:unknown } | { kind:'uuid';variable:string } | { kind:'now' } | { kind:'condition';condition:RequestCondition;then:unknown;otherwise:unknown };
export interface FieldBinding { target:string;value:FieldSource }
export type MockFault = 'EMPTY_RESPONSE'|'CONNECTION_RESET_BY_PEER'|'MALFORMED_RESPONSE_CHUNK'|'RANDOM_DATA_THEN_CLOSE';
export interface BehaviorException { id:string;name:string;conditions:RequestCondition[];overrides:Record<string,unknown>;status?:number;fault?:MockFault }
export interface BehaviorStep { name:string;status:number;overrides:Record<string,unknown>;fault?:MockFault;delay?:number }
export interface BehaviorCase { id:string;name:string;patch:{path?:string;headers?:Record<string,string>;body?:unknown;bodyMode?:'merge'|'replace'};expected:{matched?:boolean;status?:number;fields?:Record<string,unknown>;fault?:boolean};calls:number }
export interface MockBehavior { schemaVersion:1;sample:BehaviorRequest;cases:BehaviorCase[];matchers:RequestCondition[];bindings:FieldBinding[];exceptions:BehaviorException[];sequence?:{steps:BehaviorStep[];end:'hold'|'loop'|'stop'};fault?:MockFault }
export interface BehaviorPreview { caseId:string;name:string;calls:Array<{status:number;body?:unknown;text:string;matched:boolean;rule?:string;fault?:string;duration:number;errors:string[]}>;passed:boolean }
export interface MockRule { id:string;dependencyId:string;name:string;scenario:string;method:HttpMethod;path:string;service?:MockService;status:number;headers:Record<string,string>;body:unknown;delay:number;enabled:boolean;query:Record<string,string>;requestHeaders:Record<string,string>;requestBody?:unknown;bodyMatchMode?:'exact'|'partial';priority?:number;behavior?:MockBehavior;basis:string;version:number;evidence?:RuleEvidence[];assumptions?:string[];unresolved?:string[] }
export interface GenerationScope { dependencyIds:string[];scenario:'success'|'rejection'|'custom';scenarioName:string;instructions:string;model?:string;fingerprint:string }
export interface Message { id:string;role:'user'|'assistant';content:string;at:string;taskId?:string;action?:'workflow'|'mocks'|'routes' }
export interface Task { id:string;agent:string;prompt:string;status:'running'|'completed'|'failed'|'cancelled';startedAt:string;endedAt?:string;output:string;error?:string;proposal?:MockRule[];summary?:string;approved?:boolean;dependencyProposal?:DependencyDraft[];acceptedDependencies?:number[];workflowId?:string;revision?:string;kind?:'chat'|'generate';generation?:GenerationScope }
export interface Workspace { project:Project|null;workflows:Workflow[];activeWorkflowId?:string;rules:MockRule[];messages:Message[];selectedAgent:string }
export interface RequestLog { id:string;method:string;url:string;status:number;matched:boolean;rule?:string;ruleId?:string;headers?:Record<string,string>;fault?:string;at:string;body?:string;response?:string;duration?:number }
export interface RuntimeStatus { status:'stopped'|'starting'|'running'|'failed';port:number;error?:string;ready:boolean;logs:string[] }
export interface LaunchStatus { status:'stopped'|'starting'|'running'|'failed';port:number;logs:string[];error?:string;config?:string;stale?:boolean }
export interface AgentInfo { id:string;installed:boolean;version?:string;path?:string;error?:string }
export interface AgentModel { id:string;name:string;isDefault?:boolean }
export interface State { workspace:Workspace;runtime:RuntimeStatus;launch:LaunchStatus;tasks:Task[];agents:AgentInfo[];recent:{name:string;path:string;openedAt:string}[];problems:string[];terminal:string[];samplePath:string;desktop:boolean;indexing?:string }
