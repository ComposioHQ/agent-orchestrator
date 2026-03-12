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
          source = lib.cleanSource ./.;

          runtimeTools = [
            pkgs.bash
            pkgs.coreutils
            pkgs.findutils
            pkgs.gawk
            pkgs.git
            pkgs.gh
            pkgs.gnugrep
            pkgs.gnused
            pkgs.lsof
            pkgs.nodejs_20
            pkgs.pnpm_9
            pkgs.python3
            pkgs.pkg-config
            pkgs.tmux
          ] ++ lib.optionals pkgs.stdenv.isLinux [
            pkgs.gcc
            pkgs.gnumake
            pkgs.procps
            pkgs.xdg-utils
          ] ++ lib.optionals pkgs.stdenv.isDarwin [
            pkgs.gnumake
            pkgs.stdenv.cc
          ];

          ao = pkgs.writeShellApplication {
            name = "ao";
            runtimeInputs = runtimeTools;
            text = ''
              set -euo pipefail

              source_root="${source}"
              runtime_key="$(basename "$source_root")"
              cache_base="''${XDG_CACHE_HOME:-$HOME/.cache}/agent-orchestrator/nix-runtime"
              runtime_root="$cache_base/$runtime_key"
              temp_root="$cache_base/.''${runtime_key}.$$"

              if [ ! -f "$runtime_root/.ao-runtime-ready" ]; then
                rm -rf "$temp_root"
                mkdir -p "$cache_base"
                cp -R "$source_root" "$temp_root"
                chmod -R u+w "$temp_root"
                mkdir -p "$temp_root/.tmp"

                (
                  cd "$temp_root"
                  echo "Bootstrapping Agent Orchestrator in $runtime_root" >&2
                  export TMPDIR="$temp_root/.tmp"
                  export TMP="$TMPDIR"
                  export TEMP="$TMPDIR"
                  export npm_config_tmp="$TMPDIR"
                  pnpm install --frozen-lockfile
                  pnpm --filter @composio/ao-cli... build
                )

                touch "$temp_root/.ao-runtime-ready"
                rm -rf "$runtime_root"
                mv "$temp_root" "$runtime_root"
              fi

              export AO_WORKSPACE_ROOT="$runtime_root"
              export NEXT_TELEMETRY_DISABLED=1

              exec node "$runtime_root/packages/cli/dist/index.js" "$@"
            '';
            meta = with lib; {
              description = "Agent Orchestrator CLI bootstrap wrapper";
              homepage = "https://github.com/ComposioHQ/agent-orchestrator";
              license = licenses.mit;
              mainProgram = "ao";
              platforms = platforms.unix;
            };
          };
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
