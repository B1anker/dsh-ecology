# @seaveyon/dsh-pet-desktop-darwin-x64

The desktop companion binary of [@seaveyon/dsh-pet](../pet) for macOS on
Intel (`darwin`/`x64`): a single native executable under `bin/`, with the
sprite assets it renders beside it at `bin/assets/`. It is an optional
platform dependency of `@seaveyon/dsh-pet` — npm installs it automatically
on a matching machine and skips it everywhere else, so an install downloads
only the one binary (and one copy of the sprites) its platform needs. The
package is not meant for direct use; install `@seaveyon/dsh-pet` instead.
