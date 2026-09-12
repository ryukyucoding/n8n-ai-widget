'use strict';

// Pure fake-only validator/classifier for private_topology_report/v1. It never
// inspects Docker, nginx, networks, hosts, or addresses. A real operator tool
// must produce this already-sanitized shape through a separately reviewed seam.

const STATUSES = new Set(['blocked', 'candidate_private', 'verified_private']);
const ROUTE_SCOPES = new Set(['dedicated_only', 'broad_or_unknown']);
const BYPASS = new Set(['denied', 'reachable', 'unknown']);
const REACHABILITY = new Set(['reachable', 'denied', 'unknown']);
const EVIDENCE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;
const SECRET_OR_PRIVATE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}|\bbearer\s+[A-Za-z0-9._-]{8,}\b|\b(?:sk|ghp|glpat|xoxb|xoxp)-[A-Za-z0-9_-]{8,}\b|\b[A-Fa-f0-9]{40,}\b/i;
const PRIVATE_ADDRESS = /(?:https?:\/\/|\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/\d+)?\b)/i;
const MAX_TEXT = 256;

function safeText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT) return false;
  return !SECRET_OR_PRIVATE.test(value) && !PRIVATE_ADDRESS.test(value) && !/[\\\r\n]/.test(value);
}

function safeRefs(refs) {
  return Array.isArray(refs) && refs.length <= 50
    && refs.every((ref) => typeof ref === 'string' && EVIDENCE_REF.test(ref) && !ref.includes('..')
      && !SECRET_OR_PRIVATE.test(ref) && !PRIVATE_ADDRESS.test(ref));
}

function bool(value) { return value === true; }

function buildPrivateTopologyReport({
  service = {}, proxy = {}, reachability = {}, evidenceRefs = [], stopReasons = [],
} = {}) {
  const report = {
    schema: 'private_topology_report/v1',
    status: 'blocked',
    target: 'designated_chatbot',
    service: { running: bool(service.running), revisionPresent: bool(service.revisionPresent) },
    proxy: {
      dedicatedRoutePresent: bool(proxy.dedicatedRoutePresent),
      upstreamTargetsDesignatedChatbot: bool(proxy.upstreamTargetsDesignatedChatbot),
      routeScope: ROUTE_SCOPES.has(proxy.routeScope) ? proxy.routeScope : 'broad_or_unknown',
      directBypass: BYPASS.has(proxy.directBypass) ? proxy.directBypass : 'unknown',
    },
    reachability: {
      approvedOperatorPath: REACHABILITY.has(reachability.approvedOperatorPath) ? reachability.approvedOperatorPath : 'unknown',
      outsidePath: REACHABILITY.has(reachability.outsidePath) ? reachability.outsidePath : 'unknown',
      publicChatUnchanged: ['yes', 'no', 'unknown'].includes(reachability.publicChatUnchanged) ? reachability.publicChatUnchanged : 'unknown',
    },
    evidenceRefs: safeRefs(evidenceRefs) ? [...evidenceRefs] : [],
    stopReasons: Array.isArray(stopReasons) ? stopReasons.filter(safeText).slice(0, 50) : [],
  };
  const securityReady = report.service.running && report.service.revisionPresent
    && report.proxy.dedicatedRoutePresent && report.proxy.upstreamTargetsDesignatedChatbot
    && report.proxy.routeScope === 'dedicated_only' && report.proxy.directBypass === 'denied'
    && report.reachability.approvedOperatorPath === 'reachable' && report.reachability.outsidePath === 'denied'
    && report.reachability.publicChatUnchanged === 'yes' && report.evidenceRefs.length > 0;
  const candidateReady = report.proxy.dedicatedRoutePresent && report.proxy.upstreamTargetsDesignatedChatbot
    && report.proxy.routeScope === 'dedicated_only' && report.proxy.directBypass === 'denied'
    && report.reachability.approvedOperatorPath === 'reachable' && report.reachability.outsidePath === 'denied';
  report.status = securityReady ? 'verified_private' : (candidateReady ? 'candidate_private' : 'blocked');
  return report;
}

function validatePrivateTopologyReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('topology report must be an object');
  const keys = ['schema', 'status', 'target', 'service', 'proxy', 'reachability', 'evidenceRefs', 'stopReasons'];
  if (Object.keys(report).some((key) => !keys.includes(key))) throw new Error('topology report has forbidden field');
  if (report.schema !== 'private_topology_report/v1' || !STATUSES.has(report.status)) throw new Error('topology schema or status is invalid');
  if (report.target !== 'designated_chatbot') throw new Error('topology target is not designated');
  if (!report.service || typeof report.service.running !== 'boolean' || typeof report.service.revisionPresent !== 'boolean') throw new Error('service facts are invalid');
  if (!report.proxy || typeof report.proxy.dedicatedRoutePresent !== 'boolean' || typeof report.proxy.upstreamTargetsDesignatedChatbot !== 'boolean'
    || !ROUTE_SCOPES.has(report.proxy.routeScope) || !BYPASS.has(report.proxy.directBypass)) throw new Error('proxy facts are invalid');
  if (!report.reachability || !REACHABILITY.has(report.reachability.approvedOperatorPath)
    || !REACHABILITY.has(report.reachability.outsidePath) || !['yes', 'no', 'unknown'].includes(report.reachability.publicChatUnchanged)) throw new Error('reachability facts are invalid');
  if (!safeRefs(report.evidenceRefs)) throw new Error('evidence refs are invalid');
  if (!Array.isArray(report.stopReasons) || report.stopReasons.length > 50 || report.stopReasons.some((reason) => !safeText(reason))) throw new Error('stop reasons are invalid');
  if (report.status === 'verified_private') {
    const allPass = report.service.running && report.service.revisionPresent && report.proxy.dedicatedRoutePresent
      && report.proxy.upstreamTargetsDesignatedChatbot && report.proxy.routeScope === 'dedicated_only'
      && report.proxy.directBypass === 'denied' && report.reachability.approvedOperatorPath === 'reachable'
      && report.reachability.outsidePath === 'denied' && report.reachability.publicChatUnchanged === 'yes'
      && report.evidenceRefs.length > 0;
    if (!allPass) throw new Error('verified private report does not satisfy all pass conditions');
  }
  if (report.status === 'candidate_private' && (report.proxy.routeScope !== 'dedicated_only' || report.proxy.directBypass !== 'denied')) {
    throw new Error('candidate private report has unsafe route facts');
  }
  if (report.status !== 'blocked' && report.reachability.outsidePath === 'reachable') throw new Error('publicly reachable topology cannot be ready');
  return true;
}

module.exports = { STATUSES, buildPrivateTopologyReport, validatePrivateTopologyReport, safeRefs };
