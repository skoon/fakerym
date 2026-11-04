Voxel Starter Kit: Monsters (P03)
Version 1.1.0

50 catalog entries; 50 model slots; 419 assigned animation clips. Alternate formats contain the same models. Assignments can share compatible motion and do not mean unique performances. Related creatures are stylized family variants; use the inventory and previews to choose.

QUICK START
Blender: open a Source .blend in Blender 4.5.13 LTS. Select the rig and a named action to inspect animation.
FBX/GLB: import one format for each model. Hide Collision_* renderers; these are simplified collision proxies. Materials are flat embedded colors; no external textures are required.
Unity: import the supplied .unitypackage in Unity 6000.3.5f2 Built-in Render Pipeline. Files appear under Assets/VoxelStarterKit/P03. Open Scenes/P03_Showcase.unity or an individual scene in Models, or drag an individual prefab into your scene. Shared/Scripts contains the optional animation preview selector. Do not install the earlier owner-review packages in the same project; use a clean project or back up and remove the earlier imported copies first.

ANIMATION AND SCALE
Source timeline:30fps, frame1 start. Blender uses metres, Z up and -Y forward; exported files use Y up. Animation manifests give last-key minus first-key duration. Some GLBs begin at1/30 second; normalize to zero when your player requires it. Bow GLBs use120Hz sampling for string motion. In-place locomotion needs matching runtime speed; attacks can have local root offsets. Blend state changes in your controller. FBX reimport in Blender should use30fps; disconnect edit bones if inferred connections suppress animated translations.

INTEGRATION LIMITS
Unity URP/HDRP, other Unity versions, Unreal project integration and arbitrary external rigs are not tested. No driving, AI, combat, projectile, effects or gameplay controller is included. Static objects have no animation clips; documented pivots permit application-driven posing. Collision proxies are simplified bounds, not complete physics rigs. No native .vox files. Armor requires H1 masking and the supplied fitting reference; thick armor may need runtime floor adjustment during Death. Preview scenes may normalize display size; individual prefabs retain asset scale.

SUPPORT
For purchase/download issues use the publisher contact route on the marketplace product page. Include the pack ID, software version and exact reproduction steps for a defect. This fixed content release does not promise future packs, custom work or feature updates.
