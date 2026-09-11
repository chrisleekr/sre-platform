import { validateSegment } from './path';

/**
 * Generates least-privilege Kubernetes RBAC after validating interpolated resource names.
 *
 * @remarks The built-in view role excludes Secrets; the supplement grants only nodes, metrics,
 * pod logs, and a long-lived ServiceAccount token. Name validation prevents YAML injection.
 * @param params - Namespace and ServiceAccount names embedded in the manifest.
 */
export function kubernetesRbacManifest(params: {
  namespace: string;
  serviceAccount: string;
}): string {
  const ns = validateSegment('namespace', params.namespace);
  const sa = validateSegment('name', params.serviceAccount);
  const clusterRole = validateSegment('name', `${sa}-cluster-read`);
  return `apiVersion: v1
kind: Namespace
metadata:
  name: ${ns}
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${sa}
  namespace: ${ns}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ${clusterRole}
rules:
  - apiGroups: [""]
    resources: ["nodes"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["metrics.k8s.io"]
    resources: ["nodes", "pods"]
    verbs: ["get", "list"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ${sa}-view
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: view
subjects:
  - kind: ServiceAccount
    name: ${sa}
    namespace: ${ns}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ${clusterRole}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: ${clusterRole}
subjects:
  - kind: ServiceAccount
    name: ${sa}
    namespace: ${ns}
---
apiVersion: v1
kind: Secret
metadata:
  name: ${sa}-token
  namespace: ${ns}
  annotations:
    kubernetes.io/service-account.name: ${sa}
type: kubernetes.io/service-account-token
`;
}
