{
  description = "Agent Orchestrator packaged as a Nix flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          lib = pkgs.lib;
          pnpm = pkgs.pnpm_9;
          pnpmConfigHook = pkgs.pnpmConfigHook.override { inherit pnpm; };
          pnpmOs =
            if pkgs.stdenv.hostPlatform.isDarwin then
              "darwin"
            else if pkgs.stdenv.hostPlatform.isLinux then
              "linux"
            else
              pkgs.stdenv.hostPlatform.parsed.kernel.name;
          pnpmCpu =
            {
              x86_64 = "x64";
              aarch64 = "arm64";
            }.${pkgs.stdenv.hostPlatform.parsed.cpu.name} or pkgs.stdenv.hostPlatform.parsed.cpu.name;
          pnpmLibc =
            if pkgs.stdenv.hostPlatform.isLinux then
              if pkgs.stdenv.hostPlatform.isMusl then "musl" else "glibc"
            else
              null;
          source =
            lib.cleanSourceWith {
              src = ./.;
              filter =
                path: type:
                let
                  relPath = lib.removePrefix (toString ./. + "/") (toString path);
                in
                lib.cleanSourceFilter path type
                && !(relPath == "result"
                  || lib.hasPrefix "result-" relPath
                  || lib.hasPrefix ".deploy" relPath
                  || lib.hasPrefix ".stage-" relPath
                  || relPath == ".tmp"
                  || lib.hasPrefix ".tmp/" relPath
                  || lib.hasPrefix ".tmp-" relPath
                  || relPath == "node_modules"
                  || lib.hasPrefix "node_modules/" relPath
                  || lib.hasSuffix "/node_modules" relPath
                  || lib.hasInfix "/node_modules/" relPath
                  || relPath == ".next"
                  || lib.hasPrefix ".next/" relPath
                  || lib.hasSuffix "/.next" relPath
                  || lib.hasInfix "/.next/" relPath
                  || relPath == "dist"
                  || lib.hasPrefix "dist/" relPath
                  || lib.hasSuffix "/dist" relPath
                  || lib.hasInfix "/dist/" relPath
                );
            };
          runtimeTools = [
            pkgs.bash
            pkgs.coreutils
            pkgs.findutils
            pkgs.git
            pkgs.gh
            pkgs.gnugrep
            pkgs.gnused
            pkgs.lsof
            pkgs.nodejs_20
            pnpm
            pkgs.tmux
          ] ++ lib.optionals pkgs.stdenv.isLinux [
            pkgs.procps
            pkgs.xdg-utils
          ];

          ao = pkgs.stdenv.mkDerivation (finalAttrs: {
            pname = "ao";
            version =
              if self ? shortRev then
                self.shortRev
              else if self ? dirtyShortRev then
                "dirty-${self.dirtyShortRev}"
              else
                "0.1.0";

            src = source;

            pnpmDeps =
              pkgs.stdenvNoCC.mkDerivation {
                name = "${finalAttrs.pname}-pnpm-deps";
                inherit (finalAttrs) src;

                nativeBuildInputs = [
                  pkgs.cacert
                  pkgs.jq
                  pkgs.moreutils
                  pnpm
                  pkgs.yq
                ];

                dontConfigure = true;
                dontBuild = true;
                outputHashMode = "recursive";
                outputHashAlgo = "sha256";
                outputHash =
                  {
                    # Fill the remaining hashes by running the flake once on each target platform.
                    x86_64-linux = "sha256-RF3FMJKiHnHKY2sYw/XO9950uyxqUx5plK/M7Wm2I8Q=";
                    aarch64-linux = lib.fakeHash;
                    x86_64-darwin = lib.fakeHash;
                    aarch64-darwin = lib.fakeHash;
                  }.${system};

                installPhase = ''
                  runHook preInstall

                  lockfileVersion="$(yq -r .lockfileVersion pnpm-lock.yaml)"
                  if [[ ''${lockfileVersion:0:1} -gt ${lib.versions.major pnpm.version} ]]; then
                    echo "ERROR: lockfileVersion $lockfileVersion in pnpm-lock.yaml is too new for pnpm ${lib.versions.major pnpm.version}"
                    exit 1
                  fi

                  export HOME="$(mktemp -d)"
                  export CI=1

                  pushd ..
                  pnpm config set manage-package-manager-versions false
                  popd

                  pnpm config set supported-architectures.os "['${pnpmOs}']"
                  pnpm config set supported-architectures.cpu "['${pnpmCpu}']"
                  ${lib.optionalString (pnpmLibc != null) ''
                    pnpm config set supported-architectures.libc "['${pnpmLibc}']"
                  ''}
                  pnpm config set store-dir "$out"
                  pnpm config set side-effects-cache false
                  pnpm config set update-notifier false

                  pnpm install \
                    --ignore-scripts \
                    --frozen-lockfile

                  runHook postInstall
                '';

                fixupPhase = ''
                  runHook preFixup

                  rm -rf "$out"/{v3,v10}/tmp
                  export TMPDIR="${TMPDIR:-$PWD/.tmp}"
                  mkdir -p "$TMPDIR"
                  find "$out" -name '*.json' -print0 | while IFS= read -r -d "" file; do
                    chmod u+w "$file"
                    tmp_file="$(mktemp)"
                    jq --sort-keys 'del(.. | .checkedAt?)' "$file" > "$tmp_file"
                    mv "$tmp_file" "$file"
                  done
                  rm -rf "$out"/{v3,v10}/projects

                  find "$out" -type f -name '*-exec' -print0 | xargs -0 chmod 555
                  find "$out" -type f -not -name '*-exec' -print0 | xargs -0 chmod 444
                  find "$out" -type d -print0 | xargs -0 chmod 555

                  runHook postFixup
                '';
              };

            nativeBuildInputs = [
              pkgs.makeWrapper
              pkgs.nodejs_20
              pkgs.pkg-config
              pnpm
              pnpmConfigHook
              pkgs.python3
            ] ++ lib.optionals pkgs.stdenv.isLinux [
              pkgs.gcc
              pkgs.gnumake
            ] ++ lib.optionals pkgs.stdenv.isDarwin [
              pkgs.gnumake
              pkgs.stdenv.cc
            ];

            buildPhase = ''
              runHook preBuild
              export HOME="$TMPDIR/home"
              export PATH="${lib.makeBinPath runtimeTools}:$PATH"
              export CI=1
              mkdir -p "$HOME"
              cat > "$TMPDIR/agent-orchestrator.yaml" <<'EOF'
              projects: {}
              EOF
              export AO_CONFIG_PATH="$TMPDIR/agent-orchestrator.yaml"
              export NEXT_TELEMETRY_DISABLED=1
              export npm_config_nodedir="${pkgs.nodejs_20}"
              node scripts/rebuild-node-pty.js
              pnpm -r --filter @composio/ao-cli... --filter @composio/ao-web... build
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              export PATH="${lib.makeBinPath runtimeTools}:$PATH"
              export npm_config_nodedir="${pkgs.nodejs_20}"
              rm -rf .deploy
              mkdir -p .deploy/runtime/packages/plugins

              cp package.json .deploy/runtime/package.json
              cp pnpm-lock.yaml .deploy/runtime/pnpm-lock.yaml
              cp pnpm-workspace.yaml .deploy/runtime/pnpm-workspace.yaml

              mkdir -p .deploy/runtime/packages/cli
              cp packages/cli/package.json .deploy/runtime/packages/cli/package.json
              cp -R packages/cli/dist .deploy/runtime/packages/cli/dist
              cp -R packages/cli/templates .deploy/runtime/packages/cli/templates

              mkdir -p .deploy/runtime/packages/core
              cp packages/core/package.json .deploy/runtime/packages/core/package.json
              cp -R packages/core/dist .deploy/runtime/packages/core/dist

              for pluginDir in packages/plugins/*; do
                if [ -d "$pluginDir" ] && [ -f "$pluginDir/package.json" ] && [ -d "$pluginDir/dist" ]; then
                  mkdir -p ".deploy/runtime/$pluginDir"
                  cp "$pluginDir/package.json" ".deploy/runtime/$pluginDir/package.json"
                  cp -R "$pluginDir/dist" ".deploy/runtime/$pluginDir/dist"
                fi
              done

              (
                cd .deploy/runtime
                pnpm \
                  --store-dir "$pnpmDeps" \
                  --offline \
                  --ignore-scripts \
                  install \
                  --prod \
                  --frozen-lockfile
              )

              mkdir -p .deploy/runtime/packages/web/node_modules/@composio/ao-core .deploy/runtime/packages/web/node_modules/@anthropic-ai .deploy/runtime/packages/web/.next
              cp packages/web/package.json .deploy/runtime/packages/web/package.json
              cp -R packages/web/scripts .deploy/runtime/packages/web/scripts
              cp -R packages/web/dist .deploy/runtime/packages/web/dist
              cp packages/core/package.json .deploy/runtime/packages/web/node_modules/@composio/ao-core/package.json
              cp -R packages/core/dist .deploy/runtime/packages/web/node_modules/@composio/ao-core/dist
              cp -LR packages/core/node_modules/@anthropic-ai/sdk .deploy/runtime/packages/web/node_modules/@anthropic-ai/sdk
              cp -LR packages/core/node_modules/yaml .deploy/runtime/packages/web/node_modules/yaml
              cp -LR packages/core/node_modules/zod .deploy/runtime/packages/web/node_modules/zod
              if [ -d packages/web/public ]; then
                cp -R packages/web/public .deploy/runtime/packages/web/public
              fi
              cp -R packages/web/.next/standalone .deploy/runtime/packages/web/.next/standalone
              cp -R packages/web/.next/static .deploy/runtime/packages/web/.next/static
              cp -LR packages/web/node_modules/node-pty .deploy/runtime/packages/web/node_modules/node-pty
              cp -LR packages/web/node_modules/ws .deploy/runtime/packages/web/node_modules/ws
              if [ -d node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/build ]; then
                cp -R \
                  node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/build \
                  .deploy/runtime/packages/web/node_modules/node-pty/
              fi

              mkdir -p .deploy/runtime/packages/web/.next/standalone/packages/web/.next
              cp -R \
                .deploy/runtime/packages/web/.next/static \
                .deploy/runtime/packages/web/.next/standalone/packages/web/.next/static

              mkdir -p $out/bin $out/libexec/agent-orchestrator
              cp -R .deploy/runtime/. $out/libexec/agent-orchestrator

              makeWrapper ${pkgs.nodejs_20}/bin/node $out/bin/ao \
                --add-flags $out/libexec/agent-orchestrator/packages/cli/dist/index.js \
                --set AO_WORKSPACE_ROOT $out/libexec/agent-orchestrator \
                --set AO_WEB_DIR $out/libexec/agent-orchestrator/packages/web \
                --set NEXT_TELEMETRY_DISABLED 1 \
                --prefix PATH : ${lib.makeBinPath runtimeTools}

              runHook postInstall
            '';

            meta = with lib; {
              description = "Agent Orchestrator CLI";
              homepage = "https://github.com/ComposioHQ/agent-orchestrator";
              license = licenses.mit;
              mainProgram = "ao";
              platforms = platforms.unix;
            };
          });
        in
        {
          default = ao;
          ao = ao;
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.ao}/bin/ao";
        };
        ao = {
          type = "app";
          program = "${self.packages.${system}.ao}/bin/ao";
        };
      });

      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          pnpm = pkgs.pnpm_9;
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.gh
              pkgs.git
              pkgs.nodejs_20
              pnpm
              pkgs.python3
              pkgs.pkg-config
              pkgs.tmux
            ] ++ pkgs.lib.optionals pkgs.stdenv.isLinux [
              pkgs.gcc
              pkgs.gnumake
            ] ++ pkgs.lib.optionals pkgs.stdenv.isDarwin [
              pkgs.gnumake
              pkgs.stdenv.cc
            ];
          };
        }
      );
    };
}
