{
  autoPatchelfHook ? null,
  autoSignDarwinBinariesHook ? null,
  bun,
  bun2nix,
  cmake,
  lib,
  libopus,
  libpulseaudio ? null,
  makeWrapper,
  ninja,
  openssl,
  pcre2,
  pipewire ? null,
  pkg-config,
  rustPlatform,
  rustToolchain,
  source,
  stdenv,
  stdenvNoCC,
  unzip,
  zig,
  zlib,
}:
let
  packageJson = lib.importJSON ../packages/coding-agent/package.json;
  rootPackageJson = lib.importJSON ../package.json;
  platform =
    {
      aarch64-darwin = {
        addon = "pi_natives.darwin-arm64.node";
        nativeLibrary = "libpi_natives.dylib";
      };
      aarch64-linux = {
        addon = "pi_natives.linux-arm64.node";
        nativeLibrary = "libpi_natives.so";
      };
      x86_64-darwin = {
        addon = "pi_natives.darwin-x64-baseline.node";
        nativeLibrary = "libpi_natives.dylib";
        rustFlags = "-C target-cpu=x86-64-v2";
      };
      x86_64-linux = {
        addon = "pi_natives.linux-x64-baseline.node";
        nativeLibrary = "libpi_natives.so";
        rustFlags = "-C target-cpu=x86-64-v2";
      };
    }
    .${stdenv.hostPlatform.system} or (throw "Unsupported OMP platform: ${stdenv.hostPlatform.system}");
  patchedDependencies = lib.mapAttrs (
    _: patch: source + "/${patch}"
  ) rootPackageJson.patchedDependencies;
  patchOverrides = bun2nix.patchedDependenciesToOverrides { inherit patchedDependencies; };
  bunRuntimeTemplate = stdenvNoCC.mkDerivation {
    pname = "omp-bun-runtime-template";
    inherit (bun) version;
    src = bun.src;

    nativeBuildInputs = [ unzip ];
    dontUnpack = true;
    dontFixup = true;

    installPhase = ''
      runHook preInstall
      unzip -q "$src"
      install -Dm755 bun-*/bun "$out/libexec/bun"
      runHook postInstall
    '';
  };
  runtimeLibraries = [
    libopus
    openssl
    pcre2
  ]
  ++ lib.optionals stdenv.hostPlatform.isLinux [
    libpulseaudio
    pipewire
    stdenv.cc.cc.lib
    zlib
  ];
in
stdenv.mkDerivation (
  {
    pname = "omp";
    inherit (packageJson) version;
    src = source;

    cargoDeps = rustPlatform.importCargoLock { lockFile = ../Cargo.lock; };
    bunDeps = bun2nix.fetchBunDeps {
      bunNix = ./bun.nix;
      overrides = patchOverrides;
    };

    nativeBuildInputs = [
      bun
      bun2nix.hook
      cmake
      makeWrapper
      ninja
      pkg-config
      rustPlatform.bindgenHook
      rustPlatform.cargoSetupHook
      rustToolchain
      zig
    ]
    ++ lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ]
    ++ lib.optionals stdenv.hostPlatform.isDarwin [ autoSignDarwinBinariesHook ];

    buildInputs = [
      libopus
      openssl
      pcre2
    ]
    ++ lib.optionals stdenv.hostPlatform.isLinux [
      libpulseaudio
      pipewire
      stdenv.cc.cc.lib
      zlib
    ];

    strictDeps = true;
    # Nix builders cannot reliably hardlink cache files into node_modules
    # (and Darwin's clonefile backend also rejects store permissions).
    bunInstallFlags = [
      "--linker=isolated"
      "--backend=copyfile"
    ];
    dontConfigure = true;
    dontRunLifecycleScripts = true;
    dontUseBunBuild = true;
    dontUseBunCheck = true;
    dontUseBunInstall = true;
    dontStrip = true;

    env = {
      CMAKE_POLICY_VERSION_MINIMUM = "3.5";
      PCRE2_SYS_STATIC = "1";
      SOURCE_DATE_EPOCH = "1";
    }
    // lib.optionalAttrs (platform ? rustFlags) { RUSTFLAGS = platform.rustFlags; }
    // lib.optionalAttrs stdenv.hostPlatform.isDarwin { BUN_NO_CODESIGN_MACHO_BINARY = "1"; };

    buildPhase = ''
      runHook preBuild

      echo "Building pi-natives"
      cargo build --release -p pi-natives ${lib.optionalString stdenv.hostPlatform.isLinux "--features wayland-pipewire"}
      install -Dm755 "target/release/${platform.nativeLibrary}" \
        "packages/natives/native/${platform.addon}"
      ${lib.optionalString stdenv.hostPlatform.isLinux ''
        # The loader extracts this archived addon at runtime, so fix its
        # interpreter-independent Nix RPATH before Bun embeds it.
        autoPatchelf -- "packages/natives/native/${platform.addon}"
      ''}
      ${lib.optionalString stdenv.hostPlatform.isDarwin ''
        # arm64 Darwin requires even locally-built Mach-O addons to carry an
        # ad-hoc signature. Sign before Bun archives the file.
        signIfRequired "packages/natives/native/${platform.addon}"
      ''}

      echo "Compiling OMP"
      BUN_COMPILE_EXECUTABLE_PATH="${bunRuntimeTemplate}/libexec/bun" \
        bun --cwd="$PWD/packages/coding-agent" run build

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall

      install -Dm755 packages/coding-agent/dist/omp "$out/libexec/omp/omp"

      makeWrapper "$out/libexec/omp/omp" "$out/bin/omp" \
        --set PI_SKIP_VERSION_CHECK 1 \
        ${
          if stdenv.hostPlatform.isLinux then "--prefix LD_LIBRARY_PATH" else "--prefix DYLD_LIBRARY_PATH"
        } : "${lib.makeLibraryPath runtimeLibraries}"

      runHook postInstall
    '';

    doInstallCheck = true;
    installCheckPhase = ''
      runHook preInstallCheck
      HOME="$TMPDIR" "$out/bin/omp" --smoke-test | grep -q "smoke-test: ok"
      BUN_BE_BUN=1 "$out/libexec/omp/omp" -e \
        'if (Bun.version !== "${bun.version}" || typeof Bun.Image !== "function") process.exit(1)'
      runHook postInstallCheck
    '';

    meta = {
      description = "Terminal-based coding agent with multi-model support";
      homepage = "https://omp.sh";
      changelog = "https://github.com/can1357/oh-my-pi/releases/tag/v${packageJson.version}";
      license = lib.licenses.mit;
      mainProgram = "omp";
      platforms = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];
      sourceProvenance = with lib.sourceTypes; [
        binaryNativeCode
        fromSource
      ];
    };
  }
  // lib.optionalAttrs stdenv.hostPlatform.isDarwin {
    # The compile output is intentionally unsigned until all Darwin fixups are complete.
    darwinDontCodeSign = false;
  }
)
