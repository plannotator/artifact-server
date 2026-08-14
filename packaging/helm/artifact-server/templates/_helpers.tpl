{{- define "artifact-server.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "artifact-server.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := include "artifact-server.name" . -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "artifact-server.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "artifact-server.selectorLabels" -}}
app.kubernetes.io/name: {{ include "artifact-server.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "artifact-server.serverSelectorLabels" -}}
{{ include "artifact-server.selectorLabels" . }}
app.kubernetes.io/component: server
{{- end -}}

{{- define "artifact-server.labels" -}}
helm.sh/chart: {{ include "artifact-server.chart" . }}
{{ include "artifact-server.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "artifact-server.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "artifact-server.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- required "serviceAccount.name is required when serviceAccount.create is false" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "artifact-server.image" -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else if .Values.image.allowMutableTag -}}
{{- printf "%s:%s" .Values.image.repository .Values.image.tag -}}
{{- else -}}
{{- fail "image.digest is required; mutable tags are allowed only for local chart development with image.allowMutableTag=true" -}}
{{- end -}}
{{- end -}}

{{- define "artifact-server.validation" -}}
{{- $hasAccessKey := ne .Values.secret.keys.s3AccessKeyId "" -}}
{{- $hasSecretKey := ne .Values.secret.keys.s3SecretAccessKey "" -}}
{{- if ne $hasAccessKey $hasSecretKey -}}
{{- fail "secret.keys.s3AccessKeyId and secret.keys.s3SecretAccessKey must be configured together" -}}
{{- end -}}
{{- $hasWorkosClient := ne .Values.identity.workosClientId "" -}}
{{- $hasWorkosKey := ne .Values.secret.keys.workosApiKey "" -}}
{{- if ne $hasWorkosClient $hasWorkosKey -}}
{{- fail "identity.workosClientId and secret.keys.workosApiKey must be configured together" -}}
{{- end -}}
{{- $drainMilliseconds := add .Values.configuration.readinessWithdrawalMilliseconds .Values.configuration.shutdownDeadlineMilliseconds -}}
{{- if le (mul .Values.terminationGracePeriodSeconds 1000) $drainMilliseconds -}}
{{- fail "terminationGracePeriodSeconds must be longer than readinessWithdrawalMilliseconds plus shutdownDeadlineMilliseconds" -}}
{{- end -}}
{{- $migrationConnections := ternary 1 0 .Values.migration.enabled -}}
{{- $requiredConnections := add (mul (int .Values.replicaCount) 10) $migrationConnections -}}
{{- if lt (int .Values.configuration.postgresConnectionBudget) $requiredConnections -}}
{{- fail (printf "configuration.postgresConnectionBudget must be at least %d for %d replicas and the configured migration Job" $requiredConnections (int .Values.replicaCount)) -}}
{{- end -}}
{{- range $key := keys .Values.podLabels -}}
{{- if or (hasPrefix "app.kubernetes.io/" $key) (hasPrefix "helm.sh/" $key) (hasPrefix "artifactserver.com/" $key) -}}
{{- fail (printf "podLabels cannot replace the chart-owned label %s" $key) -}}
{{- end -}}
{{- end -}}
{{- range $key := keys .Values.podAnnotations -}}
{{- if hasPrefix "artifactserver.com/" $key -}}
{{- fail (printf "podAnnotations cannot replace the chart-owned annotation %s" $key) -}}
{{- end -}}
{{- end -}}
{{- if .Values.ingress.enabled -}}
{{- if not (hasPrefix "https://" .Values.configuration.applicationOrigin) -}}
{{- fail "ingress requires an https configuration.applicationOrigin" -}}
{{- end -}}
{{- if not (regexMatch "^https://[A-Za-z0-9.-]+$" .Values.configuration.applicationOrigin) -}}
{{- fail "ingress requires an application origin with no path or explicit port" -}}
{{- end -}}
{{- $_ := required "ingress.applicationTlsSecretName is required when ingress is enabled" .Values.ingress.applicationTlsSecretName -}}
{{- $_ := required "ingress.contentTlsSecretName is required when ingress is enabled" .Values.ingress.contentTlsSecretName -}}
{{- end -}}
{{- $_ := include "artifact-server.image" . -}}
{{- end -}}

{{- define "artifact-server.configurationChecksum" -}}
{{- dict "configuration" .Values.configuration "identity" .Values.identity "secretKeys" .Values.secret.keys | toJson | sha256sum -}}
{{- end -}}

{{- define "artifact-server.secretItems" -}}
- key: {{ .Values.secret.keys.apiToken | quote }}
  path: api-token
- key: {{ .Values.secret.keys.databaseUrl | quote }}
  path: database-url
{{- if .Values.secret.keys.s3AccessKeyId }}
- key: {{ .Values.secret.keys.s3AccessKeyId | quote }}
  path: s3-access-key-id
- key: {{ .Values.secret.keys.s3SecretAccessKey | quote }}
  path: s3-secret-access-key
{{- end }}
{{- if .Values.secret.keys.localBootstrapToken }}
- key: {{ .Values.secret.keys.localBootstrapToken | quote }}
  path: local-bootstrap-token
{{- end }}
{{- if .Values.secret.keys.workosApiKey }}
- key: {{ .Values.secret.keys.workosApiKey | quote }}
  path: workos-api-key
{{- end }}
{{- end -}}

{{- define "artifact-server.runtimeEnvironment" -}}
- name: ARTIFACT_SERVER_API_TOKEN_FILE
  value: /run/secrets/artifact-server/api-token
- name: ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL
  value: {{ .Values.configuration.bootstrapAdministratorEmail | quote }}
- name: ARTIFACT_SERVER_CONTENT_DOMAIN
  value: {{ .Values.configuration.contentDomain | quote }}
- name: ARTIFACT_SERVER_DATABASE_URL_FILE
  value: /run/secrets/artifact-server/database-url
- name: ARTIFACT_SERVER_INSTALLATION_ID
  value: {{ .Values.configuration.installationId | quote }}
- name: ARTIFACT_SERVER_ORIGIN
  value: {{ .Values.configuration.applicationOrigin | quote }}
- name: ARTIFACT_SERVER_READINESS_WITHDRAWAL_MS
  value: {{ .Values.configuration.readinessWithdrawalMilliseconds | quote }}
- name: ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE
  value: {{ .Values.configuration.requestLogSampleRate | quote }}
- name: ARTIFACT_SERVER_S3_BUCKET
  value: {{ .Values.configuration.s3.bucket | quote }}
- name: ARTIFACT_SERVER_S3_FORCE_PATH_STYLE
  value: {{ .Values.configuration.s3.forcePathStyle | quote }}
- name: ARTIFACT_SERVER_S3_REGION
  value: {{ .Values.configuration.s3.region | quote }}
- name: ARTIFACT_SERVER_SHUTDOWN_DEADLINE_MS
  value: {{ .Values.configuration.shutdownDeadlineMilliseconds | quote }}
{{- if .Values.configuration.s3.endpoint }}
- name: ARTIFACT_SERVER_S3_ENDPOINT
  value: {{ .Values.configuration.s3.endpoint | quote }}
{{- end }}
{{- if .Values.secret.keys.s3AccessKeyId }}
- name: ARTIFACT_SERVER_S3_ACCESS_KEY_ID_FILE
  value: /run/secrets/artifact-server/s3-access-key-id
- name: ARTIFACT_SERVER_S3_SECRET_ACCESS_KEY_FILE
  value: /run/secrets/artifact-server/s3-secret-access-key
{{- end }}
{{- if .Values.secret.keys.localBootstrapToken }}
- name: ARTIFACT_SERVER_LOCAL_BOOTSTRAP_TOKEN_FILE
  value: /run/secrets/artifact-server/local-bootstrap-token
{{- end }}
{{- if .Values.identity.workosClientId }}
- name: ARTIFACT_SERVER_WORKOS_API_KEY_FILE
  value: /run/secrets/artifact-server/workos-api-key
- name: ARTIFACT_SERVER_WORKOS_CLIENT_ID
  value: {{ .Values.identity.workosClientId | quote }}
{{- end }}
{{- end -}}
