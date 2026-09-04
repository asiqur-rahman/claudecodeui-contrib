// CI/CD for this CloudCLI UI repo, hosted on a self-managed Jenkins (VPS).
// Requires a Multibranch Pipeline job pointed at this repo so
// `branch 'production'`-gated stages only run for that branch.
//
// Every push, any branch: checkout, install, lint, typecheck, build (fully
// automatic, no approval needed). The Node app image is deliberately NOT
// built on every push: it compiles native modules (better-sqlite3, node-pty)
// and takes minutes, so the per-push correctness gate is `npm run build`
// (vite + tsc) in a throwaway `node:22` container. The heavier Docker image
// build only happens in "Build app image" / "Push to Docker Hub" below,
// gated to the production branch and a human approval.
//
// production branch only: an approval gate pauses the pipeline in the
// Jenkins UI before anything is pushed to Docker Hub -- nothing publishes
// without a human clicking Push within 15 minutes. Letting that window
// pass (or clicking Abort) skips the push instead of failing the build.
//
// Requires on the Jenkins agent:
//   - Docker CLI + buildx, with the Jenkins user able to reach the daemon
//     AND able to run containers as their own host UID (Install/Lint/Build
//     below run `docker run -u "$(id -u):$(id -g)"` against a plain
//     `node:22-bookworm-slim` image via `sh`, not the Docker Pipeline
//     plugin's `agent { docker {...} }` -- that plugin isn't assumed to be
//     installed, so this only needs the same Docker CLI the final push
//     stage already requires, nothing extra).
//   - A "Username with password" credential named dockerhub-credentials
//     (Docker Hub username + a Personal Access Token, not your account
//     password) -- create this in Jenkins yourself; the pipeline only
//     references it by ID, never touches the raw values in code.
// See JENKINS_SETUP.md for the one-time setup this Jenkinsfile assumes.

pipeline {
  // Single agent for the whole pipeline: Install/Lint/Typecheck/Build/
  // Suggest/Build app image/Push all run plain `sh` steps against the host's
  // Docker CLI (some of them additionally shelling out to `docker run` for
  // an ephemeral Node container) -- there's no per-stage Jenkins agent
  // switch to reason about, so the workspace is just the workspace
  // throughout. Only the approval stage overrides this with `agent none`, so
  // a pending manual approval never holds a Jenkins executor hostage (a
  // well-known input-step pitfall).
  agent any

  options {
    disableConcurrentBuilds()
    timestamps()
    timeout(time: 60, unit: 'MINUTES')
  }

  stages {
    stage('Resolve host workspace') {
      // If Jenkins itself runs in a container (true on this VPS), $WORKSPACE
      // is a path INSIDE the Jenkins container (e.g.
      // /var/jenkins_home/workspace/cloudcli-ui_production). Install/Lint/
      // Build below talk to the HOST's Docker daemon over the shared
      // socket, so a `docker run -v "$WORKSPACE:/workspace"` there asks the
      // HOST to bind-mount that path -- which doesn't exist on the host,
      // so Docker silently creates an empty directory and mounts that
      // instead (confirmed the hard way: node_modules "succeeded" into
      // that empty mount, then `npm ci` failed because the real checkout
      // was never there).
      //
      // Fix: resolve the Jenkins container's own bind mount for
      // /var/jenkins_home via `docker inspect` on itself, and rewrite
      // $WORKSPACE to the equivalent HOST-side path. If Jenkins is NOT
      // containerized (the other setup this pipeline supports -- see
      // JENKINS_SETUP.md), that mount lookup returns nothing and
      // $WORKSPACE is already a real host path, so it's used as-is.
      steps {
        script {
          env.HOST_WORKSPACE = sh(
            script: '''
              set -euo pipefail
              jenkins_home_host="$(docker inspect "$(hostname)" --format '{{range .Mounts}}{{if eq .Destination "/var/jenkins_home"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || true)"
              if [ -z "$jenkins_home_host" ]; then
                printf '%s' "$WORKSPACE"
              else
                printf '%s' "${jenkins_home_host}${WORKSPACE#/var/jenkins_home}"
              fi
            ''',
            returnStdout: true
          ).trim()
          echo "Resolved host-side workspace: ${env.HOST_WORKSPACE}"
        }
      }
    }

    stage('Install') {
      steps {
        // Install every dependency (dev + production) with npm ci, exactly
        // like the app's own Dockerfile deps stage -- native modules
        // (better-sqlite3, node-pty) need the full toolchain, so this runs
        // in the same `node:22-bookworm-slim` base with python3/make/g++
        // installed, and lifecycle scripts are skipped (the repo's
        // fix-node-pty postinstall is Windows-oriented). Runs inside a
        // throwaway container as the Jenkins user's own host UID so
        // node_modules is owned by that user, not root.
        sh '''
          set -euo pipefail
          docker run --rm \
            -u "$(id -u):$(id -g)" -e HOME=/tmp \
            -v "$HOST_WORKSPACE:/workspace" -w /workspace \
            node:22-bookworm-slim \
            bash -c "apt-get update && apt-get install -y --no-install-recommends python3 make g++ git && rm -rf /var/lib/apt/lists/* && rm -rf node_modules && npm ci --include=dev --ignore-scripts && npm rebuild better-sqlite3 node-pty"
        '''
      }
    }

    stage('Lint') {
      steps {
        // Rule selection lives in oxlint config / package.json scripts, not
        // here. Runs lint:client + lint:server (oxlint src/ server/).
        sh '''
          docker run --rm \
            -u "$(id -u):$(id -g)" \
            -v "$HOST_WORKSPACE:/workspace" -w /workspace \
            node:22-bookworm-slim \
            bash -c "npm run lint"
        '''
      }
    }

    stage('Typecheck') {
      steps {
        // Compile-time check across the client and server tsconfigs without
        // emitting -- catches type errors that vite/tsc would otherwise only
        // surface mid-build. No build tools needed, just the installed tree.
        sh '''
          docker run --rm \
            -u "$(id -u):$(id -g)" \
            -v "$HOST_WORKSPACE:/workspace" -w /workspace \
            node:22-bookworm-slim \
            bash -c "npm run typecheck"
        '''
      }
    }

    stage('Build') {
      steps {
        // "Build" here is a correctness gate (vite build + tsc compile,
        // producing dist/ and dist-server/) -- NOT the Docker app image.
        // That heavier image build (native module compile + global CLI
        // install, minutes long) only happens in "Build app image" below,
        // gated to the production branch and a human approval, mirroring
        // how the per-push gate stays fast while the release path does the
        // full thing.
        sh '''
          docker run --rm \
            -u "$(id -u):$(id -g)" \
            -v "$HOST_WORKSPACE:/workspace" -w /workspace \
            node:22-bookworm-slim \
            bash -c "npm run build"
        '''
      }
    }

    stage('Suggest version') {
      when {
        branch 'production'
      }
      steps {
        script {
          // Suggest the version tag from the current package.json version
          // (e.g. 1.37.2 -> v1.37.2). Runs node inside the same throwaway
          // node container as the other stages -- the Jenkins host itself
          // has no node binary (exit-127 trap on a bare `node -p`). The
          // operator can override in the approval below; nothing is tagged
          // or released by this pipeline.
          env.SUGGESTED_VERSION = sh(
            script: '''
              set -euo pipefail
              docker run --rm \
                -u "$(id -u):$(id -g)" \
                -v "$HOST_WORKSPACE:/workspace" -w /workspace \
                node:22-bookworm-slim \
                node -p "const v = require('./package.json').version; 'v' + v"
            ''',
            returnStdout: true
          ).trim()
        }
      }
    }

    stage('Build app image') {
      when {
        branch 'production'
      }
      steps {
        // Full production image build via the root Dockerfile/compose.yaml
        // (no cache: the source may have changed since the last push and
        // BuildKit's COPY cache is exactly what bit local rebuilds). Tagged
        // locally as cloudcli-ui:local so the push stage has a concrete
        // image to retag -- nothing leaves the machine yet.
        //
        // Cannot `cd "$HOST_WORKSPACE"` on the Jenkins host: HOST_WORKSPACE
        // is a path on the DOCKER HOST (e.g. /var/lib/docker/volumes/...),
        // which does not exist inside the Jenkins container. Instead run
        // docker compose inside a docker CLI container that bind-mounts the
        // host workspace and the host docker socket, exactly like the other
        // stages mount HOST_WORKSPACE for the host daemon.
        sh '''
          set -euo pipefail
          docker run --rm \
            -v "$HOST_WORKSPACE:/workspace" -w /workspace \
            -v /var/run/docker.sock:/var/run/docker.sock \
            docker:27-cli \
            docker compose -f compose.yaml build --no-cache cloudcli
        '''
      }
    }

    stage('Approve Docker Hub push') {
      // No agent: this stage only waits on a human via input() and holds
      // no executor while it does.
      agent none
      when {
        branch 'production'
      }
      steps {
        // Pauses here until a human approves in the Jenkins UI -- lint,
        // typecheck and build above already ran unattended; only the
        // publish step waits on a person. A single input() parameter
        // returns its raw value directly (not a map) -- must capture it
        // explicitly or RELEASE_VERSION would be empty in the next stage.
        //
        // Wrapped in its own timeout so silence has a safe default: no
        // approval within 15 minutes means "don't push", not "wait
        // forever" (the input step has no deadline of its own) and not
        // "fail the build" (the pipeline's own 60-minute timeout would
        // otherwise eventually abort the whole run). Catching the
        // interruption here and leaving RELEASE_VERSION unset lets the
        // next stage's `when` skip the push cleanly instead.
        script {
          try {
            timeout(time: 15, unit: 'MINUTES') {
              env.RELEASE_VERSION = input(
                message: "Push asiqurrahman/cloudcli-ui to Docker Hub as :production + :${env.SUGGESTED_VERSION}?",
                ok: 'Push',
                parameters: [
                  string(
                    name: 'RELEASE_VERSION',
                    defaultValue: env.SUGGESTED_VERSION,
                    description: 'Version tag to push (vX.Y.Z, e.g. v1.37.2). Leave as suggested unless you need a specific tag.'
                  )
                ]
              )
            }
          } catch (err) {
            env.RELEASE_VERSION = null
            currentBuild.result = 'ABORTED'
            echo 'No approval within 15 minutes (or approval was declined) -- skipping the Docker Hub push.'
          }
        }
      }
    }

    stage('Push to Docker Hub') {
      agent any
      when {
        allOf {
          branch 'production'
          expression { return env.RELEASE_VERSION != null }
        }
      }
      steps {
        // Push the locally built app image to Docker Hub under the
        // operator's account as `cloudcli-ui:production` and
        // `cloudcli-ui:<RELEASE_VERSION>` (e.g. v1.37.2). Requires the
        // dockerhub-credentials credential (username + Personal Access
        // Token) configured in Jenkins -- see the file header. Nothing is
        // re-built here; it only retags and pushes what "Build app image"
        // produced.
        withCredentials([usernamePassword(
          credentialsId: 'dockerhub-credentials',
          usernameVariable: 'DOCKERHUB_USERNAME',
          passwordVariable: 'DOCKERHUB_TOKEN'
        )]) {
          sh '''
            set -euo pipefail
            echo "$DOCKERHUB_TOKEN" | docker login -u "$DOCKERHUB_USERNAME" --password-stdin
            IMAGE_REF="docker.io/$DOCKERHUB_USERNAME/cloudcli-ui"
            docker tag cloudcli-ui:local "$IMAGE_REF:production"
            docker tag cloudcli-ui:local "$IMAGE_REF:${RELEASE_VERSION}"
            docker push "$IMAGE_REF:production"
            docker push "$IMAGE_REF:${RELEASE_VERSION}"
          '''
        }
      }
      post {
        always {
          sh 'docker logout || true'
        }
      }
    }
  }
}
