# Build and install from this checkout:  makepkg -si
# (packaging/aur/PKGBUILD builds a release tag from GitHub instead.)
pkgname=astro-a50
pkgver=0.2.0
pkgrel=1
pkgdesc='Linux control app for the Astro A50 gen 4 headset: EQ, mic, sidetone, stream mix, battery'
arch=('any')
url='https://github.com/onepushmain/astro-a50-linux'
license=('MIT')
depends=('chromium' 'python' 'bash' 'util-linux' 'procps-ng')
optdepends=('waybar: battery module (astro-a50-status)')
checkdepends=('nodejs')
source=()
sha256sums=()

check() {
  cd "$startdir"
  node --test test/protocol.test.js test/device.test.js test/session.test.js test/library.test.js test/ui.test.js test/controller.test.js
  python3 -I -m unittest discover -s test -p 'test_*.py'
}

package() {
  cd "$startdir"
  make DESTDIR="$pkgdir" PREFIX=/usr UDEVDIR=/usr/lib/udev/rules.d install
}
